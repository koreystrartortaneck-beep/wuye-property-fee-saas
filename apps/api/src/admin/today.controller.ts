import { Controller, Get, Injectable, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { centsToStr, toCents } from '../billing/engine/money';
import { PrismaService } from '../prisma/prisma.service';

/** 北京时间当日零点 */
function shanghaiTodayStart(): Date {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(`${s}T00:00:00+08:00`);
}

/** 北京时间的 YYYY-MM（当前账期） */
function shanghaiPeriod(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);
}

class TodayQuery {
  @IsOptional()
  @IsString()
  communityId?: string;
}

/**
 * 「今天」页数据源。
 *
 * 物业管理是强周期工作：月初出账、月中催缴、月末对账。此前看板只有 4 个
 * 静态统计卡，打开后并不知道「现在该干什么」。这里一次返回：
 * - 待我处理的事项（别人在等我）
 * - 本月出账/收缴进度（我这个月做到哪一步了）
 * - 欠费提醒（月中最该盯的事）
 * 并给出 phase 建议当前阶段，供前端把看板变成向导。
 */
@Injectable()
export class TodayService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(q: TodayQuery) {
    const period = shanghaiPeriod();
    const today = shanghaiTodayStart();
    const communityWhere = q.communityId ? { communityId: q.communityId } : {};

    const [
      pendingBindings,
      pendingTickets,
      pendingInvoices,
      reversalInvoices,
      openReconItems,
      draftBatches,
      stuckPayments,
      periodGroups,
      arrearsByHouse,
      overdueByHouse,
    ] = await Promise.all([
      this.prisma.t.houseBinding.count({ where: { status: 'PENDING' } }),
      this.prisma.t.ticket.count({ where: { status: 'PENDING', ...communityWhere } }),
      this.prisma.t.invoiceApplication.count({ where: { status: 'SUBMITTED', ...communityWhere } }),
      this.prisma.t.invoiceApplication.count({ where: { status: 'REVERSAL_REQUIRED', ...communityWhere } }),
      this.prisma.t.reconciliationItem.count({ where: { status: { in: ['OPEN', 'ESCALATED'] } } }),
      this.prisma.t.billBatch.count({ where: { status: 'DRAFT', period, ...communityWhere } }),
      // 结果待确认的订单：定时任务会兜底，但停留过久需要人工关注
      this.prisma.t.payment.count({ where: { status: 'PREPAY_UNKNOWN', ...communityWhere } }),
      /*
       * 聚合下推。原实现把账单整表拉进内存再 for 循环累加：本月账单 + 全账期未缴，
       * 按 3000 户 × 4 条规则估算，第一年 14400 行、第三年 43200 行，
       * 而这是**登录后首屏**，每次进后台都跑一次。43200 个 Decimal 对象的反序列化
       * 是数百毫秒的纯 CPU，单实例期间处理不了其它请求。
       *
       * 未缴那份按 houseId 分组：既拿到金额合计，也拿到欠费户数（原先用 Set 去重），
       * 进内存的行数从「账单数」降到「欠费户数」。
       */
      this.prisma.t.bill.groupBy({
        by: ['status'],
        where: { period, status: { in: ['UNPAID', 'PAID'] }, ...communityWhere },
        _sum: { amount: true },
        _count: { _all: true },
      }) as unknown as Promise<Array<{ status: string; _sum: { amount: { toString(): string } | null }; _count: { _all: number } }>>,
      this.prisma.t.bill.groupBy({
        by: ['houseId'],
        where: { status: 'UNPAID', ...communityWhere },
        _sum: { amount: true },
      }) as unknown as Promise<Array<{ houseId: string; _sum: { amount: { toString(): string } | null } }>>,
      this.prisma.t.bill.groupBy({
        by: ['houseId'],
        where: { status: 'UNPAID', dueDate: { lt: today }, ...communityWhere },
        _sum: { amount: true },
      }) as unknown as Promise<Array<{ houseId: string; _sum: { amount: { toString(): string } | null } }>>,
    ]);

    // 本月收缴进度
    let billCents = 0;
    let billCount = 0;
    let paidCents = 0;
    let paidCount = 0;
    for (const g of periodGroups) {
      const c = toCents((g._sum.amount ?? 0).toString());
      billCents += c;
      billCount += g._count._all;
      if (g.status === 'PAID') {
        paidCents += c;
        paidCount += g._count._all;
      }
    }
    const rate = billCents > 0 ? Math.round((paidCents / billCents) * 1000) / 10 : 0;

    // 欠费（全部账期，不限本月）
    let arrearsCents = 0;
    let overdueCents = 0;
    for (const g of arrearsByHouse) arrearsCents += toCents((g._sum.amount ?? 0).toString());
    for (const g of overdueByHouse) overdueCents += toCents((g._sum.amount ?? 0).toString());
    // 分组行数即户数，不必再用 Set 去重
    const arrearsHouseCount = arrearsByHouse.length;
    const overdueHouseCount = overdueByHouse.length;

    const todos = [
      { key: 'bindings', label: '业主实名待审核', count: pendingBindings, to: '/bindings' },
      { key: 'tickets', label: '报事报修待受理', count: pendingTickets, to: '/tickets' },
      { key: 'invoices', label: '开票申请待处理', count: pendingInvoices, to: '/invoices' },
      { key: 'reversal', label: '发票待作废重开', count: reversalInvoices, to: '/invoices' },
      { key: 'recon', label: '对账差异待处置', count: openReconItems, to: '/reconciliations' },
      { key: 'draftBatch', label: '本月账单已生成待发布', count: draftBatches, to: '/bill-run' },
      { key: 'stuckPayment', label: '支付结果待确认', count: stuckPayments, to: '/payments' },
    ].filter((t) => t.count > 0);

    /**
     * 当前阶段建议：按「本月是否出账 → 是否发布 → 是否有欠费 → 是否有对账差异」
     * 依次判断，让首屏直接告诉用户下一步做什么。
     */
    let phase: 'NEED_BILLING' | 'NEED_PUBLISH' | 'DUNNING' | 'RECONCILE' | 'CLEAR';
    if (billCount === 0 && draftBatches === 0) phase = 'NEED_BILLING';
    else if (draftBatches > 0) phase = 'NEED_PUBLISH';
    else if (arrearsHouseCount > 0) phase = 'DUNNING';
    else if (openReconItems > 0) phase = 'RECONCILE';
    else phase = 'CLEAR';

    return {
      period,
      phase,
      todos,
      todoTotal: todos.reduce((s, t) => s + t.count, 0),
      collection: {
        billAmount: centsToStr(billCents),
        paidAmount: centsToStr(paidCents),
        billCount,
        paidCount,
        rate,
      },
      arrears: {
        amount: centsToStr(arrearsCents),
        houses: arrearsHouseCount,
        overdueAmount: centsToStr(overdueCents),
        overdueHouses: overdueHouseCount,
      },
    };
  }
}

@Controller('admin/today')
@UseGuards(AdminGuard, RolesGuard)
export class TodayController {
  constructor(private readonly service: TodayService) {}

  @Get()
  overview(@Query() q: TodayQuery) {
    return this.service.overview(q);
  }
}
