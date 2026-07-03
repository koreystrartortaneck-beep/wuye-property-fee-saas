import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ErrorCode, MeterType, RuleType, ShareBy } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { BILL_NOTIFIER, BillNotifier, NoopBillNotifier } from '../notify/notify.tokens';
import { PrismaService } from '../prisma/prisma.service';
import { calcOne } from './engine/calc';
import { centsToStr, toCents } from './engine/money';
import { allocateShare } from './engine/share';
import { MeterService } from './meter.controller';

interface SkipDetail {
  houseId: string;
  code: string;
  reason: string;
}

/**
 * 出账服务。幂等锚点：
 * - BillRun 唯一键 (ruleId, period)：重复触发进入同一批次
 * - Bill 唯一键 (ruleId, houseId, period)：重跑只补缺（撞键视为已存在）
 */
@Injectable()
export class BillRunService {
  private readonly logger = new Logger('BillRun');

  constructor(
    private readonly prisma: PrismaService,
    private readonly meter: MeterService,
    @Optional() @Inject(BILL_NOTIFIER) private readonly notifier: BillNotifier = new NoopBillNotifier(),
  ) {}

  async generate(ruleId: string, period: string): Promise<{ generated: number; skipped: number }> {
    const rule = await this.prisma.t.feeRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new BizException(ErrorCode.NOT_FOUND, '规则不存在');

    const run = await this.prisma.t.billRun.upsert({
      where: { ruleId_period: { ruleId, period } },
      create: { ruleId, period, status: 'RUNNING' } as never,
      update: { status: 'RUNNING', finishedAt: null },
    });

    const houses = await this.prisma.t.house.findMany({
      where: { communityId: rule.communityId, status: 'ACTIVE', type: rule.houseType },
    });

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + rule.dueDays);
    dueDate.setHours(23, 59, 59, 0);

    let generated = 0;
    let skipped = 0;
    const skippedDetail: SkipDetail[] = [];

    const createBill = async (houseId: string, cents: number, snapshot: Record<string, unknown>) => {
      try {
        const bill = await this.prisma.t.bill.create({
          data: {
            communityId: rule.communityId,
            houseId,
            ruleId: rule.id,
            billRunId: run.id,
            period,
            title: `${rule.name} ${period}`,
            snapshot: snapshot as never,
            amount: centsToStr(cents),
            status: 'UNPAID',
            dueDate,
          } as never,
        });
        generated++;
        try {
          await this.notifier.onBillCreated(bill as never);
        } catch (e) {
          this.logger.warn(`账单通知失败 bill=${bill.id}: ${e instanceof Error ? e.message : e}`);
        }
      } catch (e) {
        // P2002 = 撞唯一键，说明该户该期账单已存在 → 幂等跳过
        if ((e as { code?: string }).code === 'P2002') return;
        throw e;
      }
    };

    if (rule.ruleType === 'SHARE') {
      const pool = await this.prisma.t.sharePool.findUnique({
        where: { ruleId_period: { ruleId, period } },
      });
      if (!pool) {
        await this.prisma.t.billRun.update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            total: houses.length,
            generated: 0,
            skipped: houses.length,
            skippedDetail: [{ houseId: '*', code: '*', reason: 'SHARE_POOL_MISSING' }] as never,
            finishedAt: new Date(),
          },
        });
        return { generated: 0, skipped: houses.length };
      }
      const shareBy = (rule.params as { shareBy: ShareBy }).shareBy;
      const { alloc, skipped: shareSkipped } = allocateShare(
        toCents(pool.totalAmount.toString()),
        houses.map((h) => ({ id: h.id, area: h.area === null ? null : h.area.toString() })),
        shareBy,
      );
      for (const houseId of shareSkipped) {
        skipped++;
        const house = houses.find((h) => h.id === houseId);
        skippedDetail.push({ houseId, code: house?.code ?? '', reason: 'AREA_MISSING' });
      }
      for (const [houseId, cents] of alloc) {
        await createBill(houseId, cents, {
          shareBy,
          poolAmount: pool.totalAmount.toString(),
          houseCount: alloc.size,
        });
      }
    } else {
      for (const house of houses) {
        let readingDiff: number | null | undefined;
        if (rule.ruleType === 'METER') {
          const meterType = (rule.params as { meterType: MeterType }).meterType;
          readingDiff = await this.meter.getDiff(house.id, meterType, period);
        }
        const result = calcOne({
          ruleType: rule.ruleType as RuleType,
          params: rule.params as Record<string, unknown>,
          house: { id: house.id, area: house.area === null ? null : house.area.toString() },
          readingDiff,
        });
        if (!result.ok) {
          skipped++;
          skippedDetail.push({ houseId: house.id, code: house.code, reason: result.skipReason });
          continue;
        }
        await createBill(house.id, result.cents, result.snapshot);
      }
    }

    await this.prisma.t.billRun.update({
      where: { id: run.id },
      data: {
        status: 'DONE',
        total: houses.length,
        generated,
        skipped,
        skippedDetail: skippedDetail as never,
        finishedAt: new Date(),
      },
    });
    this.logger.log(`出账完成 rule=${rule.name} period=${period} generated=${generated} skipped=${skipped}`);
    return { generated, skipped };
  }
}
