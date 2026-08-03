import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCode, MeterType, RuleType, ShareBy } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { toJsonColumn } from '../common/json-column';
import { PrismaService } from '../prisma/prisma.service';
import { calcOne } from './engine/calc';
import { centsToStr, toCents } from './engine/money';
import { allocateShare } from './engine/share';
import { MeterService } from './meter.controller';
import { anniversaryPeriod } from './period';

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

export interface GenerateOptions {
  /** 预览后剔除的房屋（本次不出账，计入 skippedDetail: EXCLUDED_BY_ADMIN） */
  excludeHouseIds?: string[];
}

/** 每户一个出账目标：周年方案下 period/dueDate 因户而异，legacy 全批相同 */
interface BillTarget {
  house: { id: string; code: string; area: import('@prisma/client').Prisma.Decimal | null };
  period: string;
  title: string;
  dueDate: Date;
  /** 周年账期起止，进账单 snapshot（展示层渲染「2026 年度」用） */
  periodRange?: { start: string; end: string };
}

export interface PreviewRow {
  houseId: string;
  code: string;
  displayName: string;
  period: string;
  periodRange?: { start: string; end: string };
  dueDate: string;
  amountCents: number | null;
  amount: string | null;
  snapshot: Record<string, unknown> | null;
  skipReason?: string;
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

  async generate(ruleId: string, period: string, opts?: GenerateOptions): Promise<GenerateResult> {
    const rule = await this.prisma.t.feeRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new BizException(ErrorCode.NOT_FOUND, '规则不存在');
    if (rule.ruleType === 'FORMULA') {
      throw new BizException(ErrorCode.FORMULA_INVALID, 'FORMULA 规则已停用，请先转换规则或改用账单导入');
    }
    this.assertSchemeSupported(rule);

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
          // 不整体转 never：tenantId 由租户扩展注入，只需把它从类型里 Omit 掉，
          // 其余字段的校验必须留着 —— 这里写的是账单批次，字段错就是钱错。
        } as Omit<Prisma.BillBatchUncheckedCreateInput, 'tenantId'> as Prisma.BillBatchUncheckedCreateInput,
      }));

    const run = await this.prisma.t.billRun.upsert({
      where: { ruleId_period: { ruleId, period } },
      create: { ruleId, period, status: 'RUNNING' } as Omit<
        Prisma.BillRunUncheckedCreateInput,
        'tenantId'
      > as Prisma.BillRunUncheckedCreateInput,
      update: { status: 'RUNNING', finishedAt: null },
    });

    const selection = await this.selectTargets(rule, period);
    let targets = selection.targets;
    const houses = targets.map((t) => t.house);

    let generated = 0;
    let skipped = 0;
    let generatedCents = 0;
    const skippedDetail: SkipDetail[] = [...selection.skipped];
    skipped += selection.skipped.length;

    /*
     * 预览后剔除:物业在预览里取消勾选的户,本次不出账。
     * 必须计入 skippedDetail —— 静默少出一户和多出一户同样危险,
     * 下个月对不上「为什么这户没账单」时,这里是唯一的答案。
     */
    if (opts?.excludeHouseIds?.length) {
      const exclude = new Set(opts.excludeHouseIds);
      for (const t of targets) {
        if (exclude.has(t.house.id)) {
          skipped++;
          skippedDetail.push({ houseId: t.house.id, code: t.house.code, reason: 'EXCLUDED_BY_ADMIN' });
        }
      }
      targets = targets.filter((t) => !exclude.has(t.house.id));
    }

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
    /*
     * 类型取 BillCreateManyInput 去掉 tenantId —— 租户 ID 由 prisma.t 的租户扩展
     * 自动注入（tenant-extension 的 injectData 对数组也逐项注入），所以这里不能写、
     * 也不该写。
     *
     * 不用 Record<string, unknown>：那会让 Prisma 对**其余所有字段**的校验一并失效
     * （拼错字段名、类型不符都不报错），而 createMany 是批量写，错一个字段就是几千行
     * 脏数据。这里只放弃 tenantId 一项的检查，其余照常。
     */
    const pending: Array<Omit<Prisma.BillCreateManyInput, 'tenantId'>> = [];
    /*
     * period/dueDate/title 从循环不变量变成每户值(BillTarget):
     * 周年方案下每户的账期起始日、缴费期限都不同;legacy 的 selectTargets
     * 给所有户相同的值,行为不变。写路径其余部分(批次/run/createMany/聚合)零改动。
     */
    const stageBill = (target: BillTarget, cents: number, snapshot: Record<string, unknown>) => {
      pending.push({
        communityId: rule.communityId,
        houseId: target.house.id,
        ruleId: rule.id,
        billRunId: run.id,
        batchId: batch.id,
        source: 'RULE',
        period: target.period,
        title: target.title,
        snapshot: {
          ...snapshot,
          ...(target.periodRange ? { periodStart: target.periodRange.start, periodEnd: target.periodRange.end } : {}),
        } as Prisma.InputJsonValue,
        amount: centsToStr(cents),
        status: 'DRAFT',
        dueDate: target.dueDate,
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
        // tenantId 由租户扩展注入，故此处补上类型出口（运行时值由扩展提供）
        data: pending as Prisma.BillCreateManyInput[],
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
          skippedDetail: toJsonColumn(summarizeSkipped([{ houseId: '*', code: '*', reason }])),
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
      const targetByHouse = new Map(targets.map((t) => [t.house.id, t]));
      for (const houseId of shareSkipped) {
        skipped++;
        const house = houses.find((h) => h.id === houseId);
        skippedDetail.push({ houseId, code: house?.code ?? '', reason: 'AREA_MISSING' });
      }
      for (const [houseId, cents] of alloc) {
        const target = targetByHouse.get(houseId);
        if (!target) continue; // 被剔除的户不出账(alloc 输入已过滤,防御)
        stageBill(target, cents, {
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

      for (const target of targets) {
        const house = target.house;
        let readingDiff: number | null | undefined;
        if (meterType) {
          readingDiff = diffByHouse.has(house.id) ? (diffByHouse.get(house.id) as number) : null;
        }
        const result = calcOne({
          ruleType: rule.ruleType as RuleType,
          params: rule.params as Record<string, unknown>,
          house: { id: house.id, area: house.area === null ? null : house.area.toString() },
          readingDiff,
          // 周年年度账单 = 月单价 × 12。把 ×12 放进引擎而不是让物业把单价填成 16.8:
          // 填 1.4 会少收 12 倍,而且对账查不出来(本地与微信用同一个错误值)。
          months: rule.periodScheme === 'ANNIVERSARY' && rule.ruleType === 'AREA_PRICE' ? 12 : 1,
          rounding: rule.rounding,
        });
        if (!result.ok) {
          skipped++;
          skippedDetail.push({ houseId: house.id, code: house.code, reason: result.skipReason });
          continue;
        }
        stageBill(target, result.cents, result.snapshot);
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
        skippedDetail: toJsonColumn(summarizeSkipped(skippedDetail)),
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

  /** SHARE/METER 不支持周年账期(v1 明确不做,而不是静默出错账) */
  private assertSchemeSupported(rule: { periodScheme: string; ruleType: string }): void {
    if (rule.periodScheme === 'ANNIVERSARY' && !['AREA_PRICE', 'FIXED'].includes(rule.ruleType)) {
      throw new BizException(
        ErrorCode.VALIDATION,
        '按户周年账期目前仅支持「按面积单价」与「固定金额」两种计费方式',
      );
    }
  }

  /**
   * 选房:按 periodScheme 分派。
   *
   * legacy(MONTHLY/QUARTERLY/YEARLY):原查询逐字保留 —— 按小区+房屋类型全选,
   * period/dueDate 全批相同,行为与重构前逐字节一致(现有 spec 一字不改必须绿)。
   *
   * ANNIVERSARY:只看 HouseStandard 挂接(挂了才出账,不挂 = 不出账/免收)。
   *   锚点 = 挂接 startDate ?? 房屋 handoverDate;锚点月份 == 扫描月才入选;
   *   每户各自的账期起始日做 period('2026-03-15'),dueDate = 起始 + dueDays,
   *   下限 now+7 天 —— 否则补跑历史月会生成一发布即逾期、当天就触发催缴的账单。
   */
  private async selectTargets(
    rule: Pick<
      import('@prisma/client').FeeRule,
      'id' | 'name' | 'communityId' | 'houseType' | 'dueDays' | 'periodScheme'
    >,
    runKey: string,
  ): Promise<{ targets: BillTarget[]; skipped: SkipDetail[] }> {
    if (rule.periodScheme !== 'ANNIVERSARY') {
      const houses = await this.prisma.t.house.findMany({
        where: { communityId: rule.communityId, status: 'ACTIVE', type: rule.houseType },
      });
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + rule.dueDays);
      dueDate.setHours(23, 59, 59, 0);
      return {
        targets: houses.map((h) => ({
          house: h,
          period: runKey,
          title: `${rule.name} ${runKey}`,
          dueDate,
        })),
        skipped: [],
      };
    }

    if (!/^\d{4}-\d{2}$/.test(runKey)) {
      throw new BizException(ErrorCode.VALIDATION, '按户周年出账按「扫描月」触发，账期参数应为 YYYY-MM');
    }

    const attachments = await this.prisma.t.houseStandard.findMany({
      where: { ruleId: rule.id, status: 'ACTIVE', house: { status: 'ACTIVE' } },
      include: { house: true },
    });

    const targets: BillTarget[] = [];
    const skipped: SkipDetail[] = [];
    const now = new Date();
    const minDue = new Date(now);
    minDue.setDate(minDue.getDate() + 7);

    const candidates: BillTarget[] = [];
    for (const att of attachments) {
      // endDate = 摘除:之后的扫描月不再出账,历史账单保留
      const anchor = att.startDate ?? att.house.handoverDate;
      if (!anchor) {
        skipped.push({ houseId: att.houseId, code: att.house.code, reason: 'HANDOVER_DATE_MISSING' });
        continue;
      }
      const ap = anniversaryPeriod(anchor, runKey);
      if (!ap) continue; // 锚点月份不是扫描月:这个月不该给这户出账,不算跳过
      if (att.endDate && ap.start > att.endDate) continue;

      const dueDate = new Date(ap.start);
      dueDate.setDate(dueDate.getDate() + rule.dueDays);
      if (dueDate < minDue) dueDate.setTime(minDue.getTime());
      dueDate.setHours(23, 59, 59, 0);

      const fmt = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      candidates.push({
        house: att.house,
        period: ap.period,
        title: `${rule.name} ${ap.start.getFullYear()}年度`,
        dueDate,
        periodRange: { start: fmt(ap.start), end: fmt(ap.end) },
      });
    }

    /*
     * 防双账单:锚点(放户日期/挂接起始日)被改动后,同一房年会算出**不同的**
     * period 字符串 —— 精确唯一键拦不住,重跑会出第二张。
     * 按「该规则该房在最近一年内已有非 CANCELED 账单」查重:
     * 查询按字符串区间取(period 是字典序友好的 ISO 串),
     * 再在内存里只认 YYYY-MM-DD 形状(排除同规则历史上的 legacy 月账单标签)。
     */
    if (candidates.length > 0) {
      const [y, m] = runKey.split('-').map(Number);
      const lower = `${m === 12 ? y : y - 1}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
      const upper = `${y}-${String(m).padStart(2, '0')}-99`;
      const recent = await this.prisma.t.bill.findMany({
        where: {
          ruleId: rule.id,
          houseId: { in: candidates.map((c) => c.house.id) },
          status: { notIn: ['CANCELED'] },
          period: { gte: lower, lte: upper },
        },
        select: { houseId: true, period: true },
      });
      const billed = new Map<string, string[]>();
      for (const b of recent) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.period)) continue;
        billed.set(b.houseId, [...(billed.get(b.houseId) ?? []), b.period]);
      }
      for (const c of candidates) {
        const periods = billed.get(c.house.id) ?? [];
        // 同 period 交给唯一键幂等跳过(重跑补漏的正常路径);不同 period 才是锚点漂移
        if (periods.some((pp) => pp !== c.period)) {
          skipped.push({ houseId: c.house.id, code: c.house.code, reason: 'ANNIVERSARY_ALREADY_BILLED' });
          continue;
        }
        targets.push(c);
      }
    }

    return { targets, skipped };
  }

  /**
   * 干跑预览:与 generate 同一条选房+计费路径,零写入。
   * 每行给出金额与计算依据(snapshot),物业核对后勾选剔除再生成草稿。
   */
  async preview(ruleId: string, runKey: string): Promise<{ rows: PreviewRow[]; totalCents: number; total: string }> {
    const rule = await this.prisma.t.feeRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new BizException(ErrorCode.NOT_FOUND, '规则不存在');
    if (rule.ruleType === 'FORMULA') {
      throw new BizException(ErrorCode.FORMULA_INVALID, 'FORMULA 规则已停用');
    }
    if (rule.ruleType === 'SHARE') {
      throw new BizException(ErrorCode.VALIDATION, '公摊规则按池子整批分摊，请直接生成草稿核对');
    }
    this.assertSchemeSupported(rule);

    const { targets, skipped } = await this.selectTargets(rule, runKey);

    const meterType = rule.ruleType === 'METER' ? (rule.params as { meterType: MeterType }).meterType : null;
    const diffByHouse = new Map<string, number>();
    if (meterType && targets.length > 0) {
      const readings = await this.prisma.t.meterReading.findMany({
        where: { period: runKey, meterType, houseId: { in: targets.map((t) => t.house.id) } },
        select: { houseId: true, value: true, prevValue: true },
      });
      for (const r of readings) {
        if (r.prevValue === null) continue;
        diffByHouse.set(r.houseId, Number(r.value) - Number(r.prevValue));
      }
    }

    const displayNames = new Map(
      (
        await this.prisma.t.house.findMany({
          where: { id: { in: [...targets.map((t) => t.house.id), ...skipped.map((s) => s.houseId)] } },
          select: { id: true, displayName: true },
        })
      ).map((h) => [h.id, h.displayName]),
    );

    const rows: PreviewRow[] = [];
    let totalCents = 0;
    for (const s of skipped) {
      rows.push({
        houseId: s.houseId,
        code: s.code,
        displayName: displayNames.get(s.houseId) ?? '',
        period: runKey,
        dueDate: '',
        amountCents: null,
        amount: null,
        snapshot: null,
        skipReason: s.reason,
      });
    }
    for (const t of targets) {
      const result = calcOne({
        ruleType: rule.ruleType as RuleType,
        params: rule.params as Record<string, unknown>,
        house: { id: t.house.id, area: t.house.area === null ? null : t.house.area.toString() },
        readingDiff: meterType ? (diffByHouse.get(t.house.id) ?? null) : undefined,
        months: rule.periodScheme === 'ANNIVERSARY' && rule.ruleType === 'AREA_PRICE' ? 12 : 1,
        rounding: rule.rounding,
      });
      if (!result.ok) {
        rows.push({
          houseId: t.house.id,
          code: t.house.code,
          displayName: displayNames.get(t.house.id) ?? '',
          period: t.period,
          periodRange: t.periodRange,
          dueDate: t.dueDate.toISOString(),
          amountCents: null,
          amount: null,
          snapshot: null,
          skipReason: result.skipReason,
        });
        continue;
      }
      totalCents += result.cents;
      rows.push({
        houseId: t.house.id,
        code: t.house.code,
        displayName: displayNames.get(t.house.id) ?? '',
        period: t.period,
        periodRange: t.periodRange,
        dueDate: t.dueDate.toISOString(),
        amountCents: result.cents,
        amount: centsToStr(result.cents),
        snapshot: result.snapshot,
      });
    }
    return { rows, totalCents, total: centsToStr(totalCents) };
  }
}
