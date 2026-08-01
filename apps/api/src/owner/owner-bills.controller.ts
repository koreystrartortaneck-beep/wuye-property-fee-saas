import { Controller, Get, Injectable, Param, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { BILL_STATUSES, BillStatus, ErrorCode } from '@pf/shared';
import { toCents, centsToStr } from '../billing/engine/money';
import { Current, CurrentOwner } from '../auth/current.decorator';
import { OwnerGuard } from '../auth/owner.guard';
import { BizException } from '../common/biz.exception';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { OwnerHousesService } from './owner-houses.controller';

class ListOwnerBillsQuery extends PageQuery {
  @IsString()
  @IsNotEmpty()
  houseId!: string;

  @IsOptional()
  @IsIn(BILL_STATUSES as unknown as string[])
  status?: BillStatus;

  /** 按费用科目（规则）过滤 */
  @IsOptional()
  @IsString()
  ruleId?: string;
}

@Injectable()
export class OwnerBillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly houses: OwnerHousesService,
  ) {}

  /** 该房屋名下出现过的费用科目（筛选条用） */
  async filters(ownerId: string, houseId: string) {
    await this.houses.assertOwnerHouse(ownerId, houseId);
    const grouped = await this.prisma.raw.bill.groupBy({
      by: ['ruleId'],
      where: { houseId, status: { not: 'DRAFT' } },
    });
    const ruleIds = grouped.flatMap(({ ruleId }) => (ruleId ? [ruleId] : []));
    if (ruleIds.length === 0) return [];
    const rules = await this.prisma.raw.feeRule.findMany({
      where: { id: { in: ruleIds } },
      select: { id: true, name: true },
    });
    return rules.map((r) => ({ ruleId: r.id, name: r.name }));
  }

  async list(ownerId: string, q: ListOwnerBillsQuery) {
    await this.houses.assertOwnerHouse(ownerId, q.houseId);
    // 草稿账单对业主不可见：仅允许查询非 DRAFT 状态。
    const statusFilter = q.status && q.status !== 'DRAFT' ? q.status : { not: 'DRAFT' as const };
    const where = {
      houseId: q.houseId,
      status: statusFilter,
      ...(q.ruleId ? { ruleId: q.ruleId } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.raw.bill.findMany({
        where,
        ...pageArgs(q),
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        select: {
          id: true, title: true, period: true, amount: true, status: true,
          dueDate: true, paidAt: true, snapshot: true, ruleId: true,
          // 仅用于派生 settling，不返回给业主端
          paymentId: true,
        },
      }),
      this.prisma.raw.bill.count({ where }),
    ]);
    return pageResult(await this.markSettling(list), total, q);
  }

  /**
   * 标出「业主已经付过钱、但我们还没记上」的账单。
   *
   * 为什么需要这个状态：`wx.requestPayment` 成功就是微信给的权威结论 —— 钱已经扣了。
   * 而账单要变成「已缴」，还得等我们收到回调（通常几秒）或主动查单。
   * 这中间业主看到的是「未缴」，而钱明明已经付了 —— 2026-08-01 事故里最伤人的
   * 就是这一屏：钱扣了，账单纹丝不动，界面上没有一个字解释。
   *
   * 判据取 `wxpayNotifiedAt != null`：微信的回调已经到达并验签通过，
   * 也就是微信亲口确认过这笔钱收了。用它而不是「订单存在且未终结」——
   * 后者会把「业主点开收银台又放弃了」也标成已支付，那是反向的谎。
   *
   * Bill 到 Payment 没有 Prisma 关系（只有一个 paymentId 列），所以按当页
   * 批量补一次查询，和列表里补房屋/费用名称是同一个做法。
   */
  private async markSettling<T extends { status: string; paymentId?: string | null }>(
    rows: T[],
  ): Promise<Array<Omit<T, 'paymentId'> & { settling: boolean }>> {
    const pendingIds = rows
      .filter((b) => b.status === 'UNPAID' && b.paymentId)
      .map((b) => b.paymentId as string);
    const settling = new Set<string>();
    if (pendingIds.length > 0) {
      const paid = await this.prisma.raw.payment.findMany({
        where: {
          id: { in: pendingIds },
          wxpayNotifiedAt: { not: null },
          status: { in: ['CREATED', 'PREPAY_UNKNOWN'] },
        },
        select: { id: true },
      });
      for (const p of paid) settling.add(p.id);
    }
    return rows.map((row) => {
      const { paymentId, ...rest } = row as T & { paymentId?: string | null };
      // paymentId 是内部标识，不外泄给业主端
      return { ...(rest as Omit<T, 'paymentId'>), settling: paymentId ? settling.has(paymentId) : false };
    });
  }

  /**
   * 按账期的权威小计。
   *
   * 为什么必须由服务端算：列表按 `status asc, createdAt desc` 排序，**不按账期**，
   * 所以同一个账期的账单会散落在不同分页里。小程序按 periodKey 分组时只看得到
   * 已加载的那几页，却把结果显示成「2026-05 · 5 笔 小计 ¥X」这种权威外观 ——
   * 某户 30 条账单时，业主想知道「5 月欠多少」，读到的是个偏小的错数。
   *
   * 同一份原则在首页大数字上已经落实过（summary 走权威接口，不按当前页估算），
   * 这里是当时漏掉的另一半。
   *
   * 过滤条件必须与列表完全一致，否则两处的「笔数」会对不上 —— 这类
   * 「同一个量两处显示成两个数」的问题比缺数字更难排查。
   */
  async byPeriod(ownerId: string, q: Omit<ListOwnerBillsQuery, 'page' | 'pageSize'>) {
    await this.houses.assertOwnerHouse(ownerId, q.houseId);
    const statusFilter = q.status && q.status !== 'DRAFT' ? q.status : { not: 'DRAFT' as const };
    const rows = await this.prisma.raw.bill.groupBy({
      by: ['period'],
      where: {
        houseId: q.houseId,
        status: statusFilter,
        ...(q.ruleId ? { ruleId: q.ruleId } : {}),
      },
      _count: { _all: true },
      _sum: { amount: true },
    });
    return rows
      .map((r) => ({
        period: r.period,
        count: r._count._all,
        // 金额统一转字符串：Decimal 直接序列化在不同环境下形状不一致，
        // 而小程序侧一律 Number(x).toFixed(2)，字符串最稳
        amount: (r._sum.amount ?? 0).toString(),
      }))
      // 账期倒序，与小程序的分组顺序一致，省得两边各排一次还可能排得不一样
      .sort((a, b) => (a.period < b.period ? 1 : -1));
  }

  /** 首页大数字：某房屋（或本人全部房屋）未缴汇总 */
  async summary(ownerId: string, houseId?: string) {
    let houseIds: string[];
    if (houseId) {
      await this.houses.assertOwnerHouse(ownerId, houseId);
      houseIds = [houseId];
    } else {
      const bindings = await this.prisma.raw.houseBinding.findMany({
        where: { wxUserId: ownerId, status: 'ACTIVE' },
        select: { houseId: true },
      });
      houseIds = bindings.map((b) => b.houseId);
    }
    if (houseIds.length === 0) return { unpaidTotal: '0.00', unpaidCount: 0 };

    const bills = await this.prisma.raw.bill.findMany({
      where: { houseId: { in: houseIds }, status: 'UNPAID' },
      select: { amount: true },
    });
    const cents = bills.reduce((s, b) => s + toCents(b.amount.toString()), 0);
    return { unpaidTotal: centsToStr(cents), unpaidCount: bills.length };
  }

  async detail(ownerId: string, id: string) {
    const bill = await this.prisma.raw.bill.findUnique({
      where: { id },
      include: { house: { select: { displayName: true } }, rule: { select: { name: true, ruleType: true } } },
    });
    if (!bill || bill.status === 'DRAFT') throw new BizException(ErrorCode.NOT_FOUND);
    await this.houses.assertOwnerHouse(ownerId, bill.houseId);
    const [withSettling] = await this.markSettling([bill]);
    return withSettling;
  }
}

@Controller('owner/bills')
@UseGuards(OwnerGuard)
export class OwnerBillsController {
  constructor(private readonly service: OwnerBillsService) {}

  @Get()
  list(@Current() cur: CurrentOwner, @Query() q: ListOwnerBillsQuery) {
    return this.service.list(cur.ownerId, q);
  }

  @Get('summary')
  summary(@Current() cur: CurrentOwner, @Query('houseId') houseId?: string) {
    return this.service.summary(cur.ownerId, houseId);
  }

  @Get('filters')
  filters(@Current() cur: CurrentOwner, @Query('houseId') houseId: string) {
    return this.service.filters(cur.ownerId, houseId);
  }

  /** 按账期的权威小计（分组头部用；列表分页算不出正确的小计） */
  @Get('by-period')
  byPeriod(@Current() cur: CurrentOwner, @Query() q: ListOwnerBillsQuery) {
    return this.service.byPeriod(cur.ownerId, q);
  }

  @Get(':id')
  detail(@Current() cur: CurrentOwner, @Param('id') id: string) {
    return this.service.detail(cur.ownerId, id);
  }
}
