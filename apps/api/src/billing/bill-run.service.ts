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
  skippedDetail?: SkipDetail[];
  /** 该账期批次已发布，无法再追加账单——调用方须据此给出正确提示 */
  alreadyPublished?: boolean;
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
/**
 * 跳过明细存进 Json 列前先汇总。
 *
 * 抄表规则的**首月会跳过全部房屋**（缺上期基准读数，getDiff 返回 null）——
 * 这不是边界情况，是新小区上线的必然路径。3000 户就是 3000 条明细，
 * 每条约 90 字节 → 单行 Json 约 270KB。而 GET /admin/bill-runs 用 include 返回整行、
 * 管理端按 pageSize=200 拉，理论响应体 54MB。
 *
 * 汇总后物业看到的信息其实更有用：「2998 户缺读数」比 2998 条房号列表更能说明问题；
 * 保留少量样本供定位具体是哪几户。
 */
const MAX_SKIP_SAMPLES = 50;

export interface SkippedSummary {
  total: number;
  truncated: boolean;
  /** 原因 → 户数 */
  byReason: Record<string, number>;
  /** 前若干条明细，供定位 */
  samples: SkipDetail[];
}

export function summarizeSkipped(details: SkipDetail[]): SkippedSummary {
  const byReason: Record<string, number> = {};
  for (const d of details) byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;
  return {
    total: details.length,
    truncated: details.length > MAX_SKIP_SAMPLES,
    byReason,
    samples: details.slice(0, MAX_SKIP_SAMPLES),
  };
}

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
      // 已发布批次不可再追加：调用方需据 alreadyPublished 给出正确提示，
      // 否则会把「无法补账」显示成「已生成 0 户，请核对后发布」。
      return {
        batchId: existingBatch.id,
        status: 'PUBLISHED' as const,
        generated: 0,
        skipped: 0,
        alreadyPublished: true,
      };
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

    /*
     * 先攒起来，最后一次 createMany 落库。
     *
     * 原实现逐户 create，每户 1 次数据库往返：3000 户 = 3000 次 ≈ 9 秒。不在事务里
     * 所以不会 P2028 回滚，但每日 02:00 的 cron 对 4 条规则串行跑，单小区就占住事件
     * 循环 30 余秒；手动触发则一个 HTTP 请求挂 9 秒、很可能撞网关超时，而后台仍在
     * 继续写、前端已认定失败。
     *
     * 这一处是上一批规模改造漏掉的：当时只改了「发布批次」与「账单导入」两处，
     * 而出账本身还在逐条写 —— scale.spec 的守卫也只覆盖了那两处。
     */
    const pending: Array<Record<string, unknown>> = [];
    const stageBill = (houseId: string, cents: number, snapshot: Record<string, unknown>) => {
      pending.push({
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
      });
      generatedCents += cents;
    };

    /**
     * 落库。skipDuplicates 承接原来逐条 catch P2002 的幂等语义
     * （撞 @@unique([ruleId, houseId, period]) 即该户该期已有账单 → 跳过）。
     *
     * generated 取 createMany 返回的 count 而不是 pending.length ——
     * 被跳过的那些不算「本次生成」，否则重跑补漏时会报出虚高的户数。
     * generatedCents 是本次入库金额的上界，仅用于日志；批次合计另有 aggregate 重算
     * （见下方注释：重跑时 increment 为 0 会把合计覆盖成 0.00）。
     */
    const flushBills = async () => {
      if (pending.length === 0) return;
      const res = await this.prisma.t.bill.createMany({
        data: pending as never,
        skipDuplicates: true,
      });
      generated = res.count;
    };

    const failBatchAndRun = async (skippedCount: number, reason: string) => {
      await this.prisma.t.billRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          total: houses.length,
          generated: 0,
          skipped: skippedCount,
          skippedDetail: summarizeSkipped([{ houseId: '*', code: '*', reason }]) as never,
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
      /*
       * 公摊规则不允许在已出过账的账期上重跑。
       *
       * allocateShare 按「当前」房屋集合把池子分完。重跑时房屋集合若变了（新交付
       * 一栋楼、某户改成停用、房屋类型调整），已存在的账单会撞
       * @@unique([ruleId,houseId,period]) 被幂等跳过、金额保持旧的分摊结果，而新增
       * 的房屋按新分摊拿到金额 —— 两套分摊叠加，账单合计超过池子：
       *   池 ¥300 / 4 户 → 每户 ¥75；新增第 5 户后重跑 → 新分摊每户 ¥60，
       *   前 4 户保持 ¥75、第 5 户拿 ¥60 → 合计 ¥360，比池子多收 ¥60。
       * 户数越多超收越大，且完全静默——出账页只会显示「跳过 4 户」。
       *
       * 这里不做「按剩余池子给新户分摊」的补救：那样新老户单价不同，业主一对账
       * 就是纠纷。正确做法是让物业先作废该账期的批次，再整批重出。
       */
      const existing = await this.prisma.t.bill.findMany({
        where: { ruleId, period, status: { notIn: ['CANCELED'] } },
        select: { id: true, status: true },
      });
      if (existing.length > 0) {
        const paid = existing.filter((b) => b.status !== 'DRAFT' && b.status !== 'UNPAID').length;
        await failBatchAndRun(
          houses.length,
          `SHARE_ALREADY_GENERATED:该账期已出过 ${existing.length} 张公摊账单` +
            (paid > 0 ? `（其中 ${paid} 张已产生收款）` : '') +
            '。公摊是把总额按当前房屋分完，重跑会与已有账单叠加、合计超过分摊池，' +
            '请先作废该账期的批次再整批重出。',
        );
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
        stageBill(houseId, cents, {
          shareBy,
          poolAmount: pool.totalAmount.toString(),
          houseCount: alloc.size,
        });
      }
    } else {
      /*
       * 抄表读数一次批量取回，不再每户查一次。
       *
       * 原实现在循环里调 meter.getDiff(house.id, ...)，每户 1 次数据库往返。
       * 3000 户的 METER 规则 = 3000 次额外往返 ≈ 9 秒，叠加逐户 create 后总计约
       * 6007 次往返 ≈ 18 秒。每日 02:00 的 cron 对 4 条规则串行跑，单小区就占住
       * 事件循环 45-75 秒；手动触发则是一个 HTTP 请求挂 9-18 秒，很可能撞网关超时，
       * 而此时后台仍在继续写，前端却已认定生成失败。
       *
       * @@unique([houseId, meterType, period]) 支持这个 IN 批查。
       * 判定逻辑与 getDiff 保持一致：缺本期读数、或缺上期读数（prevValue 为 null）
       * 一律返回 null → calcOne 以 METER_READING_MISSING 跳过该户。
       * 后者是小区上线首月的必然路径：若按 0 计会把累计读数当本期用量，
       * 读数 1234、单价 3.5 时开出 ¥4319 而实际应约 ¥105。
       */
      const meterType = rule.ruleType === 'METER' ? (rule.params as { meterType: MeterType }).meterType : null;
      const diffByHouse = new Map<string, number>();
      if (meterType) {
        const readings = await this.prisma.t.meterReading.findMany({
          where: { period, meterType, houseId: { in: houses.map((h) => h.id) } },
          select: { houseId: true, value: true, prevValue: true },
        });
        for (const r of readings) {
          if (r.prevValue === null) continue; // 缺上期基准 → 跳过该户，绝不按 0 计
          diffByHouse.set(r.houseId, Number(r.value) - Number(r.prevValue));
        }
      }

      for (const house of houses) {
        let readingDiff: number | null | undefined;
        if (meterType) {
          readingDiff = diffByHouse.has(house.id) ? (diffByHouse.get(house.id) as number) : null;
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
        stageBill(house.id, result.cents, result.snapshot);
      }
    }

    await flushBills();

    await this.prisma.t.billRun.update({
      where: { id: run.id },
      data: {
        status: 'DONE',
        total: houses.length,
        generated,
        skipped,
        skippedDetail: summarizeSkipped(skippedDetail) as never,
        finishedAt: new Date(),
      },
    });
    // 汇总必须按「批次内全部有效账单」重算，不能用本次运行的增量：
    // 重跑补漏时已存在的户会撞唯一键跳过，increment 为 0，
    // 若直接写回就会把批次合计覆盖成 0.00，发布页显示「N 户 · ¥0.00」，
    // 收费员失去唯一的核对依据。
    const aggregate = await this.prisma.t.bill.aggregate({
      where: { batchId: batch.id, status: { not: 'CANCELED' } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const batchTotal = aggregate._sum.amount ? aggregate._sum.amount.toString() : '0.00';
    // 状态只在批次仍为草稿态时回写，避免与「生成过程中被发布」竞态导致
    // 已 PUBLISHED 的批次被退回 DRAFT。
    await this.prisma.t.billBatch.updateMany({
      where: { id: batch.id, status: { in: ['DRAFT', 'GENERATING'] } },
      data: {
        status: 'DRAFT',
        totalRows: houses.length,
        validRows: aggregate._count._all,
        invalidRows: skipped,
        totalAmount: batchTotal,
      },
    });
    this.logger.log(`草稿出账 rule=${rule.name} period=${period} batch=${batch.id} generated=${generated} skipped=${skipped}`);
    return { batchId: batch.id, status: 'DRAFT', generated, skipped, skippedDetail };
  }
}
