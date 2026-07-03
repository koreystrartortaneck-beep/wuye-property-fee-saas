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

interface BillLite {
  communityId: string;
  amount: { toString(): string };
  status: string;
}

function summarize(bills: BillLite[]) {
  let billCents = 0;
  let paidCents = 0;
  let paidCount = 0;
  for (const b of bills) {
    const cents = toCents(b.amount.toString());
    billCents += cents;
    if (b.status === 'PAID') {
      paidCents += cents;
      paidCount++;
    }
  }
  return {
    billAmount: centsToStr(billCents),
    billCount: bills.length,
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
    const bills = await this.prisma.t.bill.findMany({
      where: {
        status: { not: 'CANCELED' },
        ...(q.communityId ? { communityId: q.communityId } : {}),
        ...(q.period ? { period: q.period } : {}),
      },
      select: { communityId: true, amount: true, status: true },
    });
    return summarize(bills);
  }

  @Get('by-community')
  async byCommunity(@Query() q: StatsQuery) {
    const [bills, communities] = await Promise.all([
      this.prisma.t.bill.findMany({
        where: { status: { not: 'CANCELED' }, ...(q.period ? { period: q.period } : {}) },
        select: { communityId: true, amount: true, status: true },
      }),
      this.prisma.t.community.findMany({ select: { id: true, name: true } }),
    ]);
    const byId = new Map<string, BillLite[]>();
    for (const b of bills) {
      const list = byId.get(b.communityId) ?? [];
      list.push(b);
      byId.set(b.communityId, list);
    }
    return communities.map((c) => ({
      communityId: c.id,
      name: c.name,
      ...summarize(byId.get(c.id) ?? []),
    }));
  }
}
