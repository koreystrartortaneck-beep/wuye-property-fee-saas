import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { toCents, centsToStr } from '../billing/engine/money';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';

class StatsQuery {
  @IsOptional()
  @IsString()
  communityId?: string;

  @IsOptional()
  @IsString()
  period?: string;
}

/** groupBy 的一行：某小区某状态的笔数与金额 */
interface StatusGroup {
  communityId: string;
  status: string;
  _sum: { amount: { toString(): string } | null };
  _count: { _all: number };
}

/**
 * 从「按小区 × 状态」的分组结果算出四个数字。
 *
 * 原实现是把账单整表拉进内存再 for 循环累加：
 *   GET /admin/stats/summary       第一年 144000 行 / 第三年 432000 行
 *   GET /admin/stats/by-community  同上，再在 JS 里按小区建 Map
 *   GET /admin/today               第一年 14400 行 / 第三年 43200 行
 * （按 3000 户 × 4 条计费规则 × 12 个月估算；不传 period 时是全历史。）
 * today 是登录后首屏，每次进后台都跑一次；by-community 的 Decimal 对象数量在
 * 云托管的内存上限下有 OOM 风险。四个数字全部可以用一次 groupBy 得到，
 * 进内存的行数降到「小区数 × 状态数」这个量级。
 */
function summarizeGroups(groups: StatusGroup[]) {
  let billCents = 0;
  let billCount = 0;
  let paidCents = 0;
  let paidCount = 0;
  for (const g of groups) {
    const cents = toCents((g._sum.amount ?? 0).toString());
    billCents += cents;
    billCount += g._count._all;
    if (g.status === 'PAID') {
      paidCents += cents;
      paidCount += g._count._all;
    }
  }
  return {
    billAmount: centsToStr(billCents),
    billCount,
    paidAmount: centsToStr(paidCents),
    paidCount,
    rate: billCents === 0 ? 0 : Math.round((paidCents / billCents) * 1000) / 10, // 百分比一位小数
  };
}

/** 收缴统计（排除已作废账单） */
@Controller('admin/stats')
@UseGuards(AdminGuard, RolesGuard)
export class StatsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('summary')
  async summary(@Query() q: StatsQuery) {
    const groups = (await this.prisma.t.bill.groupBy({
      by: ['communityId', 'status'],
      where: {
        status: { notIn: ['CANCELED', 'DRAFT'] },
        ...(q.communityId ? { communityId: q.communityId } : {}),
        ...(q.period ? { period: q.period } : {}),
      },
      _sum: { amount: true },
      _count: { _all: true },
    })) as unknown as StatusGroup[];
    return summarizeGroups(groups);
  }

  @Get('by-community')
  async byCommunity(@Query() q: StatsQuery) {
    const [groups, communities] = await Promise.all([
      this.prisma.t.bill.groupBy({
        by: ['communityId', 'status'],
        where: { status: { notIn: ['CANCELED', 'DRAFT'] }, ...(q.period ? { period: q.period } : {}) },
        _sum: { amount: true },
        _count: { _all: true },
      }) as unknown as Promise<StatusGroup[]>,
      this.prisma.t.community.findMany({ select: { id: true, name: true } }),
    ]);
    const byId = new Map<string, StatusGroup[]>();
    for (const g of groups) {
      const list = byId.get(g.communityId) ?? [];
      list.push(g);
      byId.set(g.communityId, list);
    }
    return communities.map((c) => ({
      communityId: c.id,
      name: c.name,
      ...summarizeGroups(byId.get(c.id) ?? []),
    }));
  }
}
