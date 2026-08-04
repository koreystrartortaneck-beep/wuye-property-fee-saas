import { Body, Controller, Injectable, Logger, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
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
 * 关于审计记录:应用层「审计不可删」这条保证仍然成立 —— AuditLog 上有
 * BEFORE DELETE 触发器,任何 SQL 删除都会被数据库拒掉。这个端点是唯一的例外:
 * 它会**临时摘掉触发器**、只删指定小区的审计行、然后立刻装回去并复验。
 * 而「删了多少条审计」这件事本身会永久写进审计 —— 链条断在哪里,链条自己记着。
 */

const TRIGGERS = [
  ['AuditLog_before_update_append_only', 'UPDATE', 'AuditLog is append-only: UPDATE is forbidden'],
  ['AuditLog_before_delete_append_only', 'DELETE', 'AuditLog is append-only: DELETE is forbidden'],
] as const;

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

  /** 小区专用:同意连它名下的审计记录一起销毁(唯一能突破「审计不可删」的开关) */
  @IsOptional()
  @IsBoolean()
  purgeAuditLogs?: boolean;
}

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger('Maintenance');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async purge(dto: PurgeDto, adminId: string) {
    return dto.target === 'HOUSE' ? this.purgeHouse(dto, adminId) : this.purgeCommunity(dto, adminId);
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

    const bills = await this.prisma.t.bill.findMany({ where: { houseId: house.id }, select: { id: true } });
    const billIds = bills.map((b) => b.id);
    const payments = await this.prisma.t.payment.findMany({
      where: { OR: [{ billId: { in: billIds.length ? billIds : ['-'] } }, { paymentBills: { some: { billId: { in: billIds.length ? billIds : ['-'] } } } }] },
      select: { id: true },
    });
    const paymentIds = [...new Set(payments.map((p) => p.id))];
    const refunds = paymentIds.length
      ? await this.prisma.t.refund.findMany({ where: { paymentId: { in: paymentIds } }, select: { id: true } })
      : [];
    const refundIds = refunds.map((r) => r.id);

    const counts: Record<string, number> = {};
    const del = async (label: string, fn: () => Promise<{ count: number }>) => {
      counts[label] = (await fn()).count;
    };

    // 先记账再动手:删完就查不出来了
    await this.audit.append({
      tenantId: house.tenantId,
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
    });

    /*
     * 删除顺序按外键从叶到根。顺序错了会被数据库拒掉(那是安全的失败),
     * 但每加一张新表都要想到这里 —— 所以逐张写清,不用「聪明」的循环。
     */
    if (refundIds.length) {
      await del('refundAttempt', () => this.prisma.t.refundAttempt.deleteMany({ where: { refundId: { in: refundIds } } }));
    }
    if (paymentIds.length || refundIds.length) {
      await del('paymentEvent', () =>
        this.prisma.t.paymentEvent.deleteMany({
          where: { OR: [{ paymentId: { in: paymentIds } }, { refundId: { in: refundIds } }] },
        }),
      );
    }
    if (paymentIds.length) {
      await del('invoiceApplication', () => this.prisma.t.invoiceApplication.deleteMany({ where: { paymentId: { in: paymentIds } } }));
      await del('refund', () => this.prisma.t.refund.deleteMany({ where: { paymentId: { in: paymentIds } } }));
      await del('paymentBill', () => this.prisma.raw.paymentBill.deleteMany({ where: { paymentId: { in: paymentIds } } }));
    }
    if (billIds.length) {
      await del('paymentBillByBill', () => this.prisma.raw.paymentBill.deleteMany({ where: { billId: { in: billIds } } }));
      await del('notifyLog', () => this.prisma.t.notifyLog.deleteMany({ where: { billId: { in: billIds } } }));
      // Bill.paymentId 是唯一外键指向 Payment:先摘掉引用,才能删 Payment
      await this.prisma.t.bill.updateMany({ where: { id: { in: billIds } }, data: { paymentId: null } });
    }
    if (paymentIds.length) {
      await del('payment', () => this.prisma.t.payment.deleteMany({ where: { id: { in: paymentIds } } }));
    }
    await del('bill', () => this.prisma.t.bill.deleteMany({ where: { houseId: house.id } }));
    await del('houseBinding', () => this.prisma.t.houseBinding.deleteMany({ where: { houseId: house.id } }));
    await del('houseContact', () => this.prisma.t.houseContact.deleteMany({ where: { houseId: house.id } }));
    await del('houseStandard', () => this.prisma.t.houseStandard.deleteMany({ where: { houseId: house.id } }));
    await del('ticket', () => this.prisma.t.ticket.deleteMany({ where: { houseId: house.id } }));
    await del('visitorPass', () => this.prisma.t.visitorPass.deleteMany({ where: { houseId: house.id } }));
    await del('serviceOrder', () => this.prisma.t.serviceOrder.deleteMany({ where: { houseId: house.id } }));
    await this.prisma.t.house.delete({ where: { id: house.id } });

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

    const auditCount = await this.prisma.t.auditLog.count({ where: { communityId: community.id } });
    if (auditCount > 0 && !dto.purgeAuditLogs) {
      throw new BizException(
        ErrorCode.VALIDATION,
        `「${community.name}」下还有审计记录 ${auditCount} 条。审计按设计不可删除;` +
          '确实要连审计一起销毁,请显式带上 purgeAuditLogs=true —— 这件事本身会被永久记入审计。',
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
      beforeSummary: { name: community.name, status: community.status, auditLogsDestroyed: auditCount },
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

    if (auditCount > 0) {
      counts.auditLog = await this.deleteAuditLogsWithTriggersOff(community.tenantId, community.id);
    }
    await this.prisma.t.community.delete({ where: { id: community.id } });

    this.logger.warn(`彻底删除小区 ${community.name} by=${adminId} 明细=${JSON.stringify(counts)}`);
    return { purged: true, target: 'COMMUNITY', name: community.name, deleted: counts };
  }

  /**
   * 摘掉 AuditLog 的 append-only 触发器 → 删指定小区的审计行 → 立刻装回并复验。
   *
   * DDL 在 MySQL 里会隐式提交,所以这段**不可能**放进事务里。风险是进程在
   * 「摘掉」与「装回」之间死掉,那时审计表会静默地变成可改可删 ——
   * 所以装回放在 finally,并且装回之后必须去 information_schema 复查两个触发器
   * 都在;查不到就抛错并打 error 日志,绝不让它静默通过。
   */
  private async deleteAuditLogsWithTriggersOff(tenantId: string, communityId: string): Promise<number> {
    let deleted = 0;
    try {
      for (const [name] of TRIGGERS) {
        await this.prisma.raw.$executeRawUnsafe(`DROP TRIGGER IF EXISTS \`${name}\``);
      }
      deleted = await this.prisma.raw.$executeRaw`
        DELETE FROM \`AuditLog\` WHERE \`tenantId\` = ${tenantId} AND \`communityId\` = ${communityId}
      `;
    } finally {
      for (const [name, event, message] of TRIGGERS) {
        await this.prisma.raw.$executeRawUnsafe(
          `CREATE TRIGGER \`${name}\` BEFORE ${event} ON \`AuditLog\` FOR EACH ROW ` +
            `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${message}'`,
        );
      }
      const rows = await this.prisma.raw.$queryRaw<Array<{ TRIGGER_NAME: string }>>`
        SELECT TRIGGER_NAME FROM information_schema.TRIGGERS
        WHERE EVENT_OBJECT_TABLE = 'AuditLog' AND TRIGGER_SCHEMA = DATABASE()
      `;
      const back = new Set(rows.map((r) => r.TRIGGER_NAME));
      const missing = TRIGGERS.map(([n]) => n).filter((n) => !back.has(n));
      if (missing.length > 0) {
        this.logger.error(`审计触发器未能装回:${missing.join(', ')} —— 审计表目前可改可删,必须立即人工修复`);
        throw new BizException(ErrorCode.INTERNAL, `审计触发器未能恢复(${missing.join(', ')}),请立即联系维护`);
      }
    }
    return deleted;
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
