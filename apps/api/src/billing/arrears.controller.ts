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
import { RateLimit } from '../common/rate-limit.guard';

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

  /** 明细列表最多返回多少户。超出时 truncated 为 true，合计仍是全量真值。 */
  private static readonly LIST_CAP = 500;

  async list(q: ArrearsQuery): Promise<{
    list: ArrearsRow[];
    totalAmount: string;
    totalHouses: number;
    /** 其中已逾期的户数（全量真值，不受明细截断影响） */
    overdueHouses: number;
    truncated: boolean;
  }> {
    const today = shanghaiTodayStart();
    const where = {
      status: 'UNPAID' as const,
      ...(q.communityId ? { communityId: q.communityId } : {}),
    };

    /*
     * 按户聚合下推到 SQL，不再把账单整表拉进内存。
     *
     * 原实现 findMany({ take: 5000 }) 之后在 JS 里 reduce 求 totalAmount、
     * 用去重后的房屋数当 totalHouses。3000 户小区 × 4 条计费规则 = 单月 12000 张
     * 未缴账单，加上历史欠费更多，于是 take 只拿到不足一半，而那个 reduce 把这
     * 5000 行当成全量：**「本小区欠费 ¥X」这个数字直接是错的，且没有任何截断提示**。
     * 收费员拿它对账、导出报表。这不是慢，是算错。
     *
     * groupBy 每户一行（3000 行而不是 12000+ 行），且没有 take，因此合计是真值。
     */
    const grouped = await this.prisma.t.bill.groupBy({
      by: ['houseId'],
      where,
      _sum: { amount: true },
      _count: { _all: true },
      _min: { dueDate: true },
    });

    /*
     * 逾期天数由该户最早到期日派生。这个过滤只能在聚合后做：它是「户」的属性
     * 而不是「账单」的属性。但过滤发生在**全量**聚合结果上，所以过滤后的合计
     * 依然是真值。
     */
    const overdueDaysOf = (earliest: Date | null): number => {
      if (!earliest) return 0;
      const diff = Math.floor((today.getTime() - earliest.getTime()) / 86_400_000);
      return diff > 0 ? diff : 0;
    };

    let houses = grouped.map((g) => ({
      houseId: g.houseId,
      unpaidCount: g._count._all,
      unpaidAmount: centsToStr(toCents((g._sum.amount ?? 0).toString())),
      earliestDueDate: g._min.dueDate ?? null,
      overdueDays: overdueDaysOf(g._min.dueDate ?? null),
    }));

    if (q.overdueDays !== undefined) {
      houses = houses.filter((h) => h.overdueDays >= (q.overdueDays as number));
    }

    houses.sort((a, b) =>
      q.sort === 'days'
        ? b.overdueDays - a.overdueDays || toCents(b.unpaidAmount) - toCents(a.unpaidAmount)
        : toCents(b.unpaidAmount) - toCents(a.unpaidAmount) || b.overdueDays - a.overdueDays,
    );

    // 合计取自全量聚合（过滤后），与明细是否截断无关
    const totalCents = houses.reduce((sum, h) => sum + toCents(h.unpaidAmount), 0);
    const totalHouses = houses.length;
    /*
     * 「其中已逾期」也必须在服务端算。管理端原先用 rows.filter(overdueDays > 0)，
     * 而 rows 是截断后的明细，于是这个数字同样少报。
     */
    const overdueHouses = houses.filter((h) => h.overdueDays > 0).length;

    const page = houses.slice(0, ArrearsService.LIST_CAP);
    const pageIds = page.map((h) => h.houseId);

    // 房屋信息与账期明细只为要返回的那几百户取
    const [houseRows, periodRows] = pageIds.length
      ? await Promise.all([
          this.prisma.t.house.findMany({
            where: { id: { in: pageIds } },
            select: { id: true, code: true, displayName: true, communityId: true, ownerName: true, ownerPhone: true },
          }),
          this.prisma.t.bill.findMany({
            where: { ...where, houseId: { in: pageIds } },
            select: { houseId: true, period: true },
          }),
        ])
      : [[], []];

    const houseById = new Map(houseRows.map((h) => [h.id, h]));
    const periodsByHouse = new Map<string, string[]>();
    for (const r of periodRows) {
      const list = periodsByHouse.get(r.houseId) ?? [];
      if (!list.includes(r.period)) list.push(r.period);
      periodsByHouse.set(r.houseId, list);
    }

    const list: ArrearsRow[] = page.map((h) => {
      const house = houseById.get(h.houseId);
      return {
        houseId: h.houseId,
        code: house?.code ?? '',
        displayName: house?.displayName ?? '',
        communityId: house?.communityId ?? '',
        ownerName: house?.ownerName ?? null,
        ownerPhone: house?.ownerPhone ?? null,
        unpaidCount: h.unpaidCount,
        unpaidAmount: h.unpaidAmount,
        earliestDueDate: h.earliestDueDate,
        overdueDays: h.overdueDays,
        periods: (periodsByHouse.get(h.houseId) ?? []).sort(),
      };
    });

    return {
      list,
      totalAmount: centsToStr(totalCents),
      totalHouses,
      overdueHouses,
      truncated: totalHouses > list.length,
    };
  }

  /**
   * 批量催缴：把提醒**排入 Outbox 队列**，由投递任务发送（幂等）。
   *
   * 原实现在请求内串行发送：循环的是账单而不是房屋，每张账单经 notifier.onReminder →
   * 1 次 NotifyLog 去重查询 + 1 次 HouseBinding 查询 + 每个绑定人 1 次微信 HTTP +
   * 1 次 NotifyLog 写入。500 户 × 4 条规则 × 约 1.5 个欠费账期 ≈ 3000 张账单：
   *   数据库往返 ≈ 9600 次
   *   微信 API 调用 ≈ 3600 次串行，按 200ms/次 = **720 秒**
   * 云托管网关远早于此就切断请求，而幂等记录停在 PROCESSING，管理端此后一直报
   * 「催缴正在处理中，请稍候」——这个按钮从此再也点不动。同时这 12 分钟里单实例的
   * 事件循环被 3600 个 await 串起来，业主端缴费一起变慢。
   *
   * 改为一次 createMany 落事件，30 秒内由 dispatch 任务发出。dedupKey 用
   * `bill.<类型>:<billId>`，skipDuplicates 天然承接「每张账单每类提醒最多一次」的
   * 原有语义；投递路径与出账通知共用同一份实现（notify.service 的 send()），
   * 因此 NotifyLog 留痕、未订阅跳过、网络失败重试的行为完全一致。
   */
  async dun(
    adminId: string,
    tenantId: string,
    body: DunBody,
  ): Promise<{ queued: number; houses: number; skipped: number }> {
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
      return reservation.responseBody as { queued: number; houses: number; skipped: number };
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
        select: { id: true, houseId: true, communityId: true, period: true, amount: true, dueDate: true },
      });
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
      const events = bills.map((bill) => {
        const overdue = bill.dueDate.getTime() < now.getTime();
        const eventType = overdue ? 'bill.overdue' : 'bill.due_soon';
        return {
          tenantId,
          communityId: bill.communityId,
          aggregateType: 'Bill',
          aggregateId: bill.id,
          eventType,
          dedupKey: `${eventType}:${bill.id}`,
          payload: {
            billId: bill.id,
            houseId: bill.houseId,
            period: bill.period,
            amount: String(bill.amount),
          },
          status: 'PENDING' as const,
          attempts: 0,
          availableAt: now,
        };
      });
      const written = events.length
        ? await this.prisma.raw.outboxEvent.createMany({ data: events, skipDuplicates: true })
        : { count: 0 };
      const queued = written.count;
      // 撞 dedupKey 被跳过的：这张账单这一类提醒已经排过/发过了
      const skipped = events.length - queued;
      const result = { queued, houses: new Set(bills.map((b) => b.houseId)).size, skipped };
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

  /*

   * 批量催缴：有幂等键但没有频率上限。改成落 Outbox 之后单次调用很快，

   * 反而更容易被连点——每次都会给一批业主排通知，重复排会耗掉他们的订阅额度。

   */

  @RateLimit({ limit: 6, windowMs: 60_000, message: '催缴发送过于频繁，请稍后再试' })

  @Post('dun')
  dun(@Current() cur: CurrentAdmin, @Body() body: DunBody) {
    if (!cur.tenantId) throw new BizException(ErrorCode.FORBIDDEN, '请先选择物业公司');
    return this.service.dun(cur.adminId, cur.tenantId, body);
  }
}
