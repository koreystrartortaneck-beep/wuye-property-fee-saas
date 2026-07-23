import { Injectable, Logger } from '@nestjs/common';
import { ErrorCode, MeterType, RuleType, ShareBy } from '@pf/shared';
import { BizException } from '../common/biz.exception';
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

export interface GenerateResult {
  batchId: string;
  status: string;
  generated: number;
  skipped: number;
}

/**
 * 规则出账服务：生成 **DRAFT 批次 + DRAFT 账单**（业主/统计不可见，无通知），
 * 需经 BillWorkflowService.publishBatch 显式发布后才对外可见并落 Outbox 通知事件。
 * 幂等锚点：
 * - BillBatch 唯一键 (tenantId, batchNo=RULE-<period>-<ruleId>)：重复触发进入同一草稿批次
 * - BillRun 唯一键 (ruleId, period)：批次追踪
 * - Bill 唯一键 (ruleId, houseId, period)：重跑只补缺（撞键视为已存在）
 * FORMULA 规则已全域停用，不再参与出账。
 */
@Injectable()
export class BillRunService {
  private readonly logger = new Logger('BillRun');

  constructor(
    private readonly prisma: PrismaService,
    private readonly meter: MeterService,
  ) {}

  async generate(ruleId: string, period: string): Promise<GenerateResult> {
    const rule = await this.prisma.t.feeRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new BizException(ErrorCode.NOT_FOUND, '规则不存在');
    if (rule.ruleType === 'FORMULA') {
      throw new BizException(ErrorCode.FORMULA_INVALID, 'FORMULA 规则已停用，请先转换规则或改用账单导入');
    }

    const batchNo = `RULE-${period}-${ruleId}`;
    const existingBatch = await this.prisma.t.billBatch.findFirst({ where: { batchNo } });
    if (existingBatch && existingBatch.status === 'PUBLISHED') {
      return { batchId: existingBatch.id, status: 'PUBLISHED', generated: 0, skipped: 0 };
    }
    const batch =
      existingBatch ??
      (await this.prisma.t.billBatch.create({
        data: {
          communityId: rule.communityId,
          batchNo,
          period,
          title: `${rule.name} ${period}`,
          source: 'RULE',
          ruleId,
          status: 'DRAFT',
        } as never,
      }));

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
    let generatedCents = 0;
    const skippedDetail: SkipDetail[] = [];

    const createBill = async (houseId: string, cents: number, snapshot: Record<string, unknown>) => {
      try {
        await this.prisma.t.bill.create({
          data: {
            communityId: rule.communityId,
            houseId,
            ruleId: rule.id,
            billRunId: run.id,
            batchId: batch.id,
            source: 'RULE',
            period,
            title: `${rule.name} ${period}`,
            snapshot: snapshot as never,
            amount: centsToStr(cents),
            status: 'DRAFT',
            dueDate,
          } as never,
        });
        generated++;
        generatedCents += cents;
      } catch (e) {
        // P2002 = 撞唯一键，说明该户该期账单已存在 → 幂等跳过
        if ((e as { code?: string }).code === 'P2002') return;
        throw e;
      }
    };

    const failBatchAndRun = async (skippedCount: number, reason: string) => {
      await this.prisma.t.billRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          total: houses.length,
          generated: 0,
          skipped: skippedCount,
          skippedDetail: [{ houseId: '*', code: '*', reason }] as never,
          finishedAt: new Date(),
        },
      });
      await this.prisma.t.billBatch.update({
        where: { id: batch.id },
        data: { status: 'FAILED', totalRows: houses.length, validRows: 0, invalidRows: skippedCount },
      });
    };

    if (rule.ruleType === 'SHARE') {
      const pool = await this.prisma.t.sharePool.findUnique({
        where: { ruleId_period: { ruleId, period } },
      });
      if (!pool) {
        await failBatchAndRun(houses.length, 'SHARE_POOL_MISSING');
        return { batchId: batch.id, status: 'FAILED', generated: 0, skipped: houses.length };
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
    const draftCount = await this.prisma.t.bill.count({ where: { batchId: batch.id, status: 'DRAFT' } });
    await this.prisma.t.billBatch.update({
      where: { id: batch.id },
      data: {
        status: 'DRAFT',
        totalRows: houses.length,
        validRows: draftCount,
        invalidRows: skipped,
        totalAmount: centsToStr(generatedCents),
      },
    });
    this.logger.log(`草稿出账 rule=${rule.name} period=${period} batch=${batch.id} generated=${generated} skipped=${skipped}`);
    return { batchId: batch.id, status: 'DRAFT', generated, skipped };
  }
}
