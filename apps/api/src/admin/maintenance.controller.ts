import { Body, Controller, Injectable, Logger, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { Roles, RolesGuard } from '../auth/roles.decorator';
import { AuditService } from '../audit/audit.service';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';

/*
 * 彻底清除(物理删除)—— 只为一件事存在:上线前清掉联调/体验期造的测试数据。
 *
 * 为什么需要它:常规的删除刻意很保守 ——
 *   · 删房屋:名下有账单就不允许(账单是审计凭据,删房会让「这房去年收过多少」无法回答)
 *   · 删小区:名下有审计记录就永远不允许(审计按设计不可删)
 * 这两条对真实经营是对的,但对「测试期造出来的垃圾」它就成了死路:
 * 那些房和小区永远留在库里,楼盘图里灰着,列表里占着位置。
 *
 * 所以这里给一条明确的、留痕的出路,而不是让人去数据库里手动删:
 *   · 限 TENANT_ADMIN
 *   · 必须原样打出目标的名字(confirm)—— 手滑点不出来
 *   · **先写审计再删**,且审计行挂在 communityId=null 上(否则它自己会被删掉)
 *   · 返回逐表删除条数,删了什么如实报出来
 *
 * 关于审计记录:它在数据库层面不可删 —— AuditLog 上有 BEFORE DELETE 触发器,
 * 而摘触发器是 DDL,Prisma 查询引擎走预处理协议根本执行不了(MySQL 1295)。
 * 所以「审计不可删」在运行时是**硬**保证。真要清(比如上线前清测试小区),
 * 只能提交一个带 id 的一次性清理迁移,经评审进 git。
 */

class PurgeDto {
  @IsIn(['HOUSE', 'COMMUNITY'])
  target!: 'HOUSE' | 'COMMUNITY';

  @IsString()
  @IsNotEmpty()
  id!: string;

  /** 目标的名字(房屋 displayName / 小区 name),必须原样一致 */
  @IsString()
  @MaxLength(191)
  @IsNotEmpty()
  confirm!: string;
}

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger('Maintenance');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async purge(dto: PurgeDto, adminId: string) {
    /*
     * 底层错误必须原样带出来。
     *
     * 实测两次都栽在这上面:漏一张外键表 → 「关联的数据不存在或已被删除」;
     * 小区清除失败 → 「服务器内部错误」。两句话都指不到任何一张表,
     * 而这是个**破坏性**操作 —— 失败时最需要知道的就是「被哪张表挡住了」。
     * 维护端点不该把诊断信息藏起来(它本来就只有管理员能调)。
     */
    try {
      return dto.target === 'HOUSE' ? await this.purgeHouse(dto, adminId) : await this.purgeCommunity(dto, adminId);
    } catch (e) {
      if (e instanceof BizException) throw e;
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.logger.error(`彻底清除失败 target=${dto.target} id=${dto.id}: ${detail}`);
      throw new BizException(ErrorCode.VALIDATION, `彻底清除失败:${detail.slice(0, 400)}`);
    }
  }

  /**
   * 彻底删一套房:先删它名下的一切,再删房。
   *
   * 关于这套房的审计行不用动 —— AuditLog 只用字符串 resourceId 指向房屋/账单,
   * 没有外键。所以房子删了,「谁在什么时候改了它的面积」这段历史仍然留着。
   */
  private async purgeHouse(dto: PurgeDto, adminId: string) {
    const house = await this.prisma.t.house.findFirst({
      where: { id: dto.id },
      select: { id: true, code: true, displayName: true, tenantId: true, communityId: true },
    });
    if (!house) throw new BizException(ErrorCode.NOT_FOUND, '房屋不存在或不属于当前物业公司');
    if (dto.confirm !== house.displayName) {
      throw new BizException(ErrorCode.VALIDATION, `请原样输入房屋名称「${house.displayName}」以确认彻底删除`);
    }

    /*
     * 先把「牵着这套房的东西」收全,再删。两条边都要走:
     *   · 支付:主账单指向它(billId),或经 PaymentBill 关联它(一单多账单)
     *   · 退款:挂在这些支付上,**或者** Refund.billId 直接指向这些账单
     * 2026-08-04 实测:只按支付找退款,PAY-001 删到最后一步被
     * 「Bill 上的外键」挡回来 —— 库里有一笔退款是只经 billId 连着账单的。
     * 报错只说 (`tenantId`),指不到是哪张表,所以这里把两条边都写清。
     */
    const bills = await this.prisma.t.bill.findMany({ where: { houseId: house.id }, select: { id: true } });
    const billIds = bills.map((b) => b.id);
    const bIn = billIds.length ? billIds : ['-'];
    const payments = await this.prisma.t.payment.findMany({
      where: { OR: [{ billId: { in: bIn } }, { paymentBills: { some: { billId: { in: bIn } } } }] },
      select: { id: true },
    });
    let paymentIds = [...new Set(payments.map((p) => p.id))];
    const refunds = await this.prisma.t.refund.findMany({
      where: { OR: [{ paymentId: { in: paymentIds.length ? paymentIds : ['-'] } }, { billId: { in: bIn } }] },
      select: { id: true, paymentId: true },
    });
    const refundIds = refunds.map((r) => r.id);
    // 经 billId 找到的退款,它挂的那笔支付也要一起删,否则支付还牵着账单
    paymentIds = [...new Set([...paymentIds, ...refunds.map((r) => r.paymentId)])];

    /*
     * 整套删除必须在一个事务里。
     *
     * 2026-08-04 实测的教训:第一次清 PAY-001 时漏了对账明细那张表,
     * 外键在最后一步把 DELETE 挡回来 —— 而前面十几步已经各自提交了。
     * 结果是一套「退款和发票没了、房和账单还在」的半残房屋,
     * 比删失败严重得多:人看到的是失败,库里却已经少了东西。
     *
     * 事务里必须用 prisma.raw + 显式 tenantId:tx 上没有租户扩展,
     * 少写一个 tenantId 就是跨租户删除。所以每个 where 都带着它。
     */
    const counts: Record<string, number> = {};
    const tenantId = house.tenantId;
    const ids = <T,>(a: T[]) => (a.length ? a : ([('-' as unknown) as T]));

    await this.prisma.raw.$transaction(async (tx) => {
      const del = async (label: string, fn: () => Promise<{ count: number }>) => {
        counts[label] = (await fn()).count;
      };

      // 先记账,和删除同生共死:事务回滚了,这行「已销毁」也不该留下
      await this.audit.append(
        {
          tenantId,
          // 挂 null:否则这行审计会随着「彻底删小区」一起被清掉,那就等于没记
          communityId: null,
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'DELETE',
          resourceType: 'House',
          resourceId: house.id,
          reason: '彻底清除测试数据',
          beforeSummary: {
            code: house.code,
            displayName: house.displayName,
            communityId: house.communityId,
            bills: billIds.length,
            payments: paymentIds.length,
            refunds: refundIds.length,
          },
          afterSummary: { event: 'HOUSE_PURGE' },
        },
        tx,
      );

      /*
       * 删除顺序按外键从叶到根。逐张写清,不用「聪明」的循环 ——
       * 以后每加一张指向账单/支付的表,都要能在这里看见它。
       */
      await del('refundAttempt', () => tx.refundAttempt.deleteMany({ where: { tenantId, refundId: { in: ids(refundIds) } } }));
      await del('paymentEvent', () =>
        tx.paymentEvent.deleteMany({
          where: { tenantId, OR: [{ paymentId: { in: ids(paymentIds) } }, { refundId: { in: ids(refundIds) } }] },
        }),
      );
      await del('invoiceApplication', () => tx.invoiceApplication.deleteMany({ where: { tenantId, paymentId: { in: ids(paymentIds) } } }));
      // 对账明细也指向支付与退款(每日对账把每笔订单都记一行)——漏了它就是上面那次事故
      await del('reconciliationItem', () =>
        tx.reconciliationItem.deleteMany({
          where: { tenantId, OR: [{ paymentId: { in: ids(paymentIds) } }, { refundId: { in: ids(refundIds) } }] },
        }),
      );
      await del('refund', () => tx.refund.deleteMany({ where: { tenantId, id: { in: ids(refundIds) } } }));
      await del('paymentBill', () =>
        tx.paymentBill.deleteMany({ where: { OR: [{ paymentId: { in: ids(paymentIds) } }, { billId: { in: ids(billIds) } }] } }),
      );
      await del('notifyLog', () => tx.notifyLog.deleteMany({ where: { tenantId, billId: { in: ids(billIds) } } }));
      /*
       * 删账单之前先把两个引用摘断:
       *   · paymentId —— 唯一外键指向 Payment,不摘就删不了 Payment
       *   · replacesBillId —— **账单指向账单**(作废后重开会串起来)。
       *     同一条 deleteMany 里父子都在也不行:MySQL 逐行检查外键,
       *     删到父行时子行还指着它。2026-08-04 实测 PAY-001 就卡在这,
       *     而报错只说 (`tenantId`),第三次指不到表名。
       */
      await tx.bill.updateMany({
        where: { tenantId, id: { in: ids(billIds) } },
        data: { paymentId: null, replacesBillId: null },
      });
      await del('payment', () =>
        tx.payment.deleteMany({ where: { tenantId, OR: [{ id: { in: ids(paymentIds) } }, { billId: { in: ids(billIds) } }] } }),
      );
      await del('bill', () => tx.bill.deleteMany({ where: { tenantId, houseId: house.id } }));
      await del('houseBinding', () => tx.houseBinding.deleteMany({ where: { tenantId, houseId: house.id } }));
      await del('houseContact', () => tx.houseContact.deleteMany({ where: { tenantId, houseId: house.id } }));
      await del('houseStandard', () => tx.houseStandard.deleteMany({ where: { tenantId, houseId: house.id } }));
      await del('ticket', () => tx.ticket.deleteMany({ where: { tenantId, houseId: house.id } }));
      await del('visitorPass', () => tx.visitorPass.deleteMany({ where: { tenantId, houseId: house.id } }));
      await del('serviceOrder', () => tx.serviceOrder.deleteMany({ where: { tenantId, houseId: house.id } }));
      await tx.house.delete({ where: { id: house.id } });
    }, { timeout: 30_000 });

    this.logger.warn(`彻底删除房屋 ${house.code}(${house.displayName}) by=${adminId} 明细=${JSON.stringify(counts)}`);
    return { purged: true, target: 'HOUSE', code: house.code, displayName: house.displayName, deleted: counts };
  }

  /** 彻底删一个小区:要求名下已无业务数据;审计记录需显式同意才连带销毁 */
  private async purgeCommunity(dto: PurgeDto, adminId: string) {
    const community = await this.prisma.t.community.findFirst({
      where: { id: dto.id },
      select: { id: true, name: true, tenantId: true, status: true },
    });
    if (!community) throw new BizException(ErrorCode.NOT_FOUND, '小区不存在或不属于当前物业公司');
    if (dto.confirm !== community.name) {
      throw new BizException(ErrorCode.VALIDATION, `请原样输入小区名称「${community.name}」以确认彻底删除`);
    }

    /*
     * 业务数据必须先清空。这里不代劳 —— 「顺手把 551 套房和它们的账单一起删了」
     * 绝不能是一个按钮的副作用。房屋请逐套用 HOUSE 目标清除。
     */
    const client = this.prisma.t as unknown as Record<string, { count(args: unknown): Promise<number> }>;
    const BUSINESS: Array<[string, string]> = [
      ['house', '房屋'],
      ['bill', '账单'],
      ['billBatch', '出账批次'],
      ['feeRule', '收费标准'],
      ['payment', '缴费记录'],
      ['refund', '退款'],
      ['ticket', '工单'],
      ['visitorPass', '访客通行码'],
      ['workLog', '物业公示'],
      ['announcement', '公告'],
      ['coupon', '卡券'],
      ['serviceItem', '生活服务'],
      ['serviceOrder', '服务预约'],
      ['invoiceApplication', '发票申请'],
      ['communityCollectionPolicy', '收款策略'],
    ];
    const left: string[] = [];
    for (const [model, label] of BUSINESS) {
      const n = await client[model].count({ where: { communityId: community.id } });
      if (n > 0) left.push(`${label} ${n} 条`);
    }
    if (left.length > 0) {
      throw new BizException(
        ErrorCode.VALIDATION,
        `「${community.name}」下还有 ${left.join('、')}。彻底删小区要求名下先清空(房屋请逐套彻底清除)。`,
      );
    }

    /*
     * 审计记录只能由迁移清除,运行时做不到 —— 而且这是好事。
     *
     * 2026-08-04 实测:想在运行时临时摘掉 AuditLog 的 append-only 触发器,
     * MySQL 直接拒绝 1295「This command is not supported in the prepared
     * statement protocol yet」。Prisma 查询引擎走预处理协议,DROP/CREATE
     * TRIGGER 只有迁移引擎(文本协议)能执行。
     *
     * 也就是说「审计不可删」在运行时是**硬**保证:任何管理员、任何接口、
     * 任何参数都破不了。要清只能提交一个带 id 的一次性清理迁移,经评审进 git ——
     * 这比留一个能在线绕过它的开关好得多。所以这里不再假装能做,只说清出路。
     */
    const auditCount = await this.prisma.t.auditLog.count({ where: { communityId: community.id } });
    if (auditCount > 0) {
      throw new BizException(
        ErrorCode.VALIDATION,
        `「${community.name}」下还有审计记录 ${auditCount} 条。审计在数据库层面不可删除` +
          '(AuditLog 上有 BEFORE DELETE 触发器,只有迁移能摘掉它)。' +
          '要彻底清掉这个小区,需要提交一个专门的清理迁移。',
      );
    }

    // 先记账再动手,并且挂 communityId=null,免得它自己被这次清除带走
    await this.audit.append({
      tenantId: community.tenantId,
      communityId: null,
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'DELETE',
      resourceType: 'Community',
      resourceId: community.id,
      reason: '彻底清除测试小区',
      beforeSummary: { name: community.name, status: community.status },
      afterSummary: { event: 'COMMUNITY_PURGE' },
    });

    const counts: Record<string, number> = {};
    // 无业务含义的运行痕迹:幂等记录/事件队列/对账运行,直接清
    counts.idempotencyRecord = (await this.prisma.t.idempotencyRecord.deleteMany({ where: { communityId: community.id } })).count;
    counts.outboxEvent = (await this.prisma.t.outboxEvent.deleteMany({ where: { communityId: community.id } })).count;
    counts.paymentEvent = (await this.prisma.t.paymentEvent.deleteMany({ where: { communityId: community.id } })).count;
    counts.reconciliationItem = (await this.prisma.t.reconciliationItem.deleteMany({ where: { communityId: community.id } })).count;
    counts.reconciliationRun = (await this.prisma.t.reconciliationRun.deleteMany({ where: { communityId: community.id } })).count;
    counts.refundAttempt = (await this.prisma.t.refundAttempt.deleteMany({ where: { communityId: community.id } })).count;

    await this.prisma.t.community.delete({ where: { id: community.id } });

    this.logger.warn(`彻底删除小区 ${community.name} by=${adminId} 明细=${JSON.stringify(counts)}`);
    return { purged: true, target: 'COMMUNITY', name: community.name, deleted: counts };
  }

}

@Controller('admin/maintenance')
@UseGuards(AdminGuard, RolesGuard)
export class MaintenanceController {
  constructor(private readonly service: MaintenanceService) {}

  @Roles('TENANT_ADMIN')
  @Post('purge')
  purge(@Current() cur: CurrentAdmin, @Body() dto: PurgeDto) {
    return this.service.purge(dto, cur.adminId);
  }
}
