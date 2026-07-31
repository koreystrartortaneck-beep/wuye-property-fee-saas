import { Body, Controller, Get, Inject, Injectable, Optional, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { IdempotencyService } from '../common/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { centsToStr, toCents } from './engine/money';
import { BILL_NOTIFIER, BillNotifier } from '../notify/notify.tokens';

/** 北京时间的当日零点，用于按「日」判断逾期（不能用 UTC 比较） */
function shanghaiTodayStart(): Date {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(`${s}T00:00:00+08:00`);
}

class ArrearsQuery {
  @IsOptional()
  @IsString()
  communityId?: string;

  /** 只看逾期超过 N 天的（不传=全部未缴） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  overdueDays?: number;

  /** 排序：欠费金额 / 逾期天数 */
  @IsOptional()
  @IsIn(['amount', 'days'])
  sort?: 'amount' | 'days';
}

class DunBody {
  /** 要催缴的房屋 id 列表 */
  @IsString({ each: true })
  houseIds!: string[];

  @IsString()
  requestId!: string;
}

interface ArrearsRow {
  houseId: string;
  code: string;
  displayName: string;
  communityId: string;
  ownerName: string | null;
  ownerPhone: string | null;
  unpaidCount: number;
  unpaidAmount: string;
  /** 最早一笔未缴的到期日 */
  earliestDueDate: Date | null;
  /** 已逾期天数（按北京时间的日；未逾期为 0） */
  overdueDays: number;
  periods: string[];
}

/**
 * 欠费清单与催缴。
 *
 * 此前系统只能按单据列账单，没有「谁欠费、欠多久」的视图——而催缴是物业
 * 最核心的日常工作。这里按住户聚合未缴账单，给出欠费金额、笔数、账期与
 * 逾期天数，并支持批量触发催缴通知。
 */
@Injectable()
export class ArrearsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    @Optional() @Inject(BILL_NOTIFIER) private readonly notifier: BillNotifier | null = null,
  ) {}

  async list(q: ArrearsQuery): Promise<{ list: ArrearsRow[]; totalAmount: string; totalHouses: number }> {
    const today = shanghaiTodayStart();
    const bills = await this.prisma.t.bill.findMany({
      where: {
        status: 'UNPAID',
        ...(q.communityId ? { communityId: q.communityId } : {}),
      },
      select: {
        houseId: true,
        communityId: true,
        amount: true,
        period: true,
        dueDate: true,
        house: { select: { code: true, displayName: true, ownerName: true, ownerPhone: true } },
      },
      take: 5000,
    });

    const byHouse = new Map<string, ArrearsRow>();
    for (const b of bills) {
      let row = byHouse.get(b.houseId);
      if (!row) {
        row = {
          houseId: b.houseId,
          code: b.house?.code ?? '',
          displayName: b.house?.displayName ?? '',
          communityId: b.communityId,
          ownerName: b.house?.ownerName ?? null,
          ownerPhone: b.house?.ownerPhone ?? null,
          unpaidCount: 0,
          unpaidAmount: '0.00',
          earliestDueDate: null,
          overdueDays: 0,
          periods: [],
        };
        byHouse.set(b.houseId, row);
      }
      row.unpaidCount += 1;
      row.unpaidAmount = centsToStr(toCents(row.unpaidAmount) + toCents(b.amount.toString()));
      if (b.dueDate && (!row.earliestDueDate || b.dueDate < row.earliestDueDate)) {
        row.earliestDueDate = b.dueDate;
      }
      if (!row.periods.includes(b.period)) row.periods.push(b.period);
    }

    let rows = [...byHouse.values()].map((r) => {
      r.periods.sort();
      if (r.earliestDueDate) {
        const diff = Math.floor((today.getTime() - r.earliestDueDate.getTime()) / 86_400_000);
        r.overdueDays = diff > 0 ? diff : 0;
      }
      return r;
    });

    if (q.overdueDays !== undefined) {
      rows = rows.filter((r) => r.overdueDays >= (q.overdueDays as number));
    }
    rows.sort((a, b) =>
      q.sort === 'days'
        ? b.overdueDays - a.overdueDays || toCents(b.unpaidAmount) - toCents(a.unpaidAmount)
        : toCents(b.unpaidAmount) - toCents(a.unpaidAmount) || b.overdueDays - a.overdueDays,
    );

    const totalCents = rows.reduce((sum, r) => sum + toCents(r.unpaidAmount), 0);
    return { list: rows, totalAmount: centsToStr(totalCents), totalHouses: rows.length };
  }

  /** 批量催缴：对选中房屋的未缴账单逐笔触发逾期提醒（幂等） */
  async dun(
    adminId: string,
    tenantId: string,
    body: DunBody,
  ): Promise<{ notified: number; houses: number; skipped: number }> {
    if (!body.houseIds?.length) throw new BizException(ErrorCode.VALIDATION, '请选择要催缴的房屋');
    if (body.houseIds.length > 500) {
      throw new BizException(ErrorCode.VALIDATION, '单次催缴最多 500 户，请分批处理');
    }

    const reservation = await this.idempotency.reserve({
      tenantId,
      communityId: null,
      actorKey: adminId,
      action: 'admin.arrears.dun',
      requestId: body.requestId,
      payload: { houseIds: [...body.houseIds].sort() },
    });
    if (reservation.outcome === 'REPLAY') {
      return reservation.responseBody as { notified: number; houses: number; skipped: number };
    }
    if (reservation.outcome === 'IN_PROGRESS') {
      throw new BizException(ErrorCode.VALIDATION, '催缴正在处理中，请稍候');
    }
    if (reservation.outcome === 'FAILED') {
      throw new BizException(ErrorCode.VALIDATION, reservation.errorMessage);
    }

    try {
      const bills = await this.prisma.t.bill.findMany({
        where: { status: 'UNPAID', houseId: { in: body.houseIds } },
      });
      let notified = 0;
      let skipped = 0;
      /*
       * 通知类型必须按账单**实际**是否逾期来选，不能一律发 OVERDUE。
       *
       * 线上实测：给一张 2026-08-26 到期的账单发催缴，业主 7 月 31 日就收到
       * 「已逾期，请尽快处理」——离到期还有 26 天。这是直接对业主说假话，会引发投诉。
       *
       * dueDate 存的是「到期那天的上海 23:59:59」换算成的 UTC 时刻，所以
       * dueDate < now 即为已逾期，无需再做时区换算；这也与定时提醒
       * runReminders 里 `dueDate: { lt: now }` 的判定保持一致。
       */
      const now = new Date();
      for (const bill of bills) {
        if (!this.notifier) {
          skipped += 1;
          continue;
        }
        try {
          const overdue = bill.dueDate.getTime() < now.getTime();
          await this.notifier.onReminder(bill as never, overdue ? 'OVERDUE' : 'DUE_SOON');
          notified += 1;
        } catch {
          // 单笔失败不阻断整批（通知本就是尽力而为）
          skipped += 1;
        }
      }
      const result = { notified, houses: new Set(bills.map((b) => b.houseId)).size, skipped };
      await this.idempotency.complete({
        tenantId,
        recordId: reservation.recordId,
        responseCode: 0,
        responseBody: result,
      });
      return result;
    } catch (error) {
      await this.idempotency.fail({
        tenantId,
        recordId: reservation.recordId,
        errorCode: 'DUN_FAILED',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

@Controller('admin/arrears')
@UseGuards(AdminGuard, RolesGuard)
export class ArrearsController {
  constructor(private readonly service: ArrearsService) {}

  @Get()
  list(@Query() q: ArrearsQuery) {
    return this.service.list(q);
  }

  @Post('dun')
  dun(@Current() cur: CurrentAdmin, @Body() body: DunBody) {
    if (!cur.tenantId) throw new BizException(ErrorCode.FORBIDDEN, '请先选择物业公司');
    return this.service.dun(cur.adminId, cur.tenantId, body);
  }
}
