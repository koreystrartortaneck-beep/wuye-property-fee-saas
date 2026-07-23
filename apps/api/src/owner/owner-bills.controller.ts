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
        },
      }),
      this.prisma.raw.bill.count({ where }),
    ]);
    return pageResult(list, total, q);
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
    return bill;
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

  @Get(':id')
  detail(@Current() cur: CurrentOwner, @Param('id') id: string) {
    return this.service.detail(cur.ownerId, id);
  }
}
