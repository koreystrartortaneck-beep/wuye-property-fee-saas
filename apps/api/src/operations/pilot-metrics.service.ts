import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_MAX_ATTEMPTS, TERMINAL_AVAILABLE_AT } from '../notify/outbox.service';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// 灰度通过阈值（分子/分母口径见各指标返回体）
const PAYMENT_SUCCESS_MIN = 0.995;
const REFUND_COMPLETION_MIN = 0.99;
const DUPLICATE_CHARGE_MAX = 0;
const UNRESOLVED_RECON_MAX = 0;
const SEVERE_INCIDENT_MAX = 0;

export interface MetricsInput {
  tenantId: string;
  communityId?: string | null;
  now?: Date;
}

interface DailyRow {
  day: string;
  success: number | bigint;
  total: number | bigint;
}

function ratePass(numerator: number, denominator: number, min: number) {
  const rate = denominator === 0 ? 1 : numerator / denominator;
  return { numerator, denominator, rate, threshold: min, pass: rate >= min };
}

/**
 * 灰度试点指标：均来自持久化记录（而非日志）。
 * 口径显式给出分子/分母与通过阈值，返回按日明细与滚动 30 日值。
 */
@Injectable()
export class PilotMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async metrics(input: MetricsInput) {
    const now = input.now ?? new Date();
    const since = new Date(now.getTime() - THIRTY_DAYS_MS);
    const cf = input.communityId ? { communityId: input.communityId } : {};

    const [
      paySuccess,
      payFailed,
      prepayUnknown,
      dupGroups,
      unresolvedRecon,
      refundSuccess,
      refundTerminal,
      refundAbnormal,
      severeIncidents,
      dailyRows,
      outboxStuck,
      outboxExhausted,
      notifyFailed,
      notifyUnauthorized,
    ] = await Promise.all([
      /*
       * 「支付技术成功率」的分子分母都必须把 REFUNDED 算进来。
       *
       * 原来只数 status='SUCCESS'。而一笔支付成功之后被退款，状态变成 REFUNDED ——
       * 于是它**从分子和分母里同时消失**。2026-08-01 实测：当天 4 笔成功支付，
       * 全部退款后，日报表上这一天显示 0/0，看图的人以为一整天没有交易。
       *
       * 更糟的推论：某天 10 笔支付，9 笔成功后退款、1 笔失败，
       * 这个指标会显示 0/1 = 0% —— 「支付全线失败」，而真实成功率是 90%。
       * 用当前状态去衡量「当时有没有成功」，本身就是错的。
       *
       * 同一份认识在 duplicateChargeCount 那条 groupBy 里已经落实了
       * （它用的是 ['SUCCESS','REFUNDED']），只有成功率这两条漏了。
       *
       * 另：只统计线上渠道。线下登记是管理员手工录入、不经过微信，永远「成功」，
       * 把它算进「技术成功率」等于用手工录入去稀释线上通道的真实可靠性。
       */
      this.prisma.t.payment.count({
        where: { channel: 'WXPAY', status: { in: ['SUCCESS', 'REFUNDED'] }, createdAt: { gte: since }, ...cf },
      }),
      this.prisma.t.payment.count({
        where: { channel: 'WXPAY', status: { in: ['FAILED'] }, createdAt: { gte: since }, ...cf },
      }),
      this.prisma.t.payment.count({ where: { status: 'PREPAY_UNKNOWN', createdAt: { gte: since }, ...cf } }),
      this.prisma.t.payment.groupBy({
        by: ['billId'],
        where: { status: { in: ['SUCCESS', 'REFUNDED'] }, createdAt: { gte: since }, billId: { not: null }, ...cf },
        _count: { _all: true },
      }) as unknown as Promise<Array<{ billId: string | null; _count: { _all: number } }>>,
      this.prisma.t.reconciliationItem.count({ where: { status: { in: ['OPEN', 'ESCALATED'] }, ...cf } }),
      this.prisma.t.refund.count({ where: { status: 'SUCCESS', requestedAt: { gte: since }, ...cf } }),
      this.prisma.t.refund.count({ where: { status: { in: ['SUCCESS', 'FAILED', 'ABNORMAL'] }, requestedAt: { gte: since }, ...cf } }),
      this.prisma.t.refund.count({ where: { status: 'ABNORMAL', ...cf } }),
      this.prisma.t.incident.count({ where: { severity: 'CRITICAL', openedAt: { gte: since }, ...cf } }),
      this.dailyPaymentSuccess(input.tenantId, input.communityId ?? null, since),
      /*
       * Outbox 与通知的健康度此前完全没有被任何监控覆盖：事件重试耗尽后变成
       * FAILED 永久沉在库里，业主该收到的账单/催缴就这么无声无息地丢了，而后台
       * 任何页面都看不出异常。这三项把它摆到界面上。
       *
       * 「积压」= 待投递或可重试且已到点却还没被投出去（正常应当在 30 秒内清掉）。
       */
      this.prisma.raw.outboxEvent.count({
        where: {
          tenantId: input.tenantId,
          status: { in: ['PENDING', 'FAILED'] },
          availableAt: { lte: now, not: TERMINAL_AVAILABLE_AT },
          // 与领取条件保持一致；超次数的事件永远不会再被领取，算「已放弃」而非「待投递」
          attempts: { lt: DEFAULT_MAX_ATTEMPTS },
        },
      }),
      this.prisma.raw.outboxEvent.count({
        where: {
          tenantId: input.tenantId,
          status: 'FAILED',
          // 两种都算已放弃：已打上终态哨兵的，以及超次数但还没来得及打哨兵的
          OR: [{ availableAt: TERMINAL_AVAILABLE_AT }, { attempts: { gte: DEFAULT_MAX_ATTEMPTS } }],
        },
      }),
      this.prisma.raw.notifyLog.count({
        where: { tenantId: input.tenantId, status: 'FAILED', sentAt: { gte: since } },
      }),
      /*
       * 把「业主没授权」从通知失败里摘出来。
       *
       * 微信一次性订阅：业主授权一次只能收一条，额度用完后再发就是
       * 43101 user refuse to accept the msg。这**不是系统故障**，
       * 是这类订阅的固有限制。生产实测 15 条失败里绝大多数是它。
       *
       * 不摘出来的后果不是「数字难看」，而是**真故障会被埋掉**：
       * 模板 ID 配错（43102/47003）、openid 失效（40003）这些必须有人处理的失败，
       * 混在十几条 43101 里没人会发现。这就是告警疲劳把真问题盖住的经典形状，
       * 而今天两次事故的共性恰恰是「出问题看不出来」。
       */
      this.prisma.raw.notifyLog.count({
        where: {
          tenantId: input.tenantId,
          status: 'FAILED',
          sentAt: { gte: since },
          error: { startsWith: '43101' },
        },
      }),
    ]);

    const duplicateChargeCount = dupGroups.filter((g) => g.billId && g._count._all > 1).length;

    const paymentTechnicalSuccessRate = ratePass(paySuccess, paySuccess + payFailed, PAYMENT_SUCCESS_MIN);
    const refundCompletionRate = ratePass(refundSuccess, refundTerminal, REFUND_COMPLETION_MIN);
    const duplicateCharge = { value: duplicateChargeCount, threshold: DUPLICATE_CHARGE_MAX, pass: duplicateChargeCount <= DUPLICATE_CHARGE_MAX };
    const unresolvedReconciliationDifferences = { value: unresolvedRecon, threshold: UNRESOLVED_RECON_MAX, pass: unresolvedRecon <= UNRESOLVED_RECON_MAX };
    const severeIncidentCount = { value: severeIncidents, threshold: SEVERE_INCIDENT_MAX, pass: severeIncidents <= SEVERE_INCIDENT_MAX };
    const moneyLoss = duplicateChargeCount > 0 || unresolvedRecon > 0 || refundAbnormal > 0;
    const moneyLossIndicator = { value: moneyLoss, abnormalRefunds: refundAbnormal, pass: !moneyLoss };

    const overallPass =
      paymentTechnicalSuccessRate.pass &&
      refundCompletionRate.pass &&
      duplicateCharge.pass &&
      unresolvedReconciliationDifferences.pass &&
      severeIncidentCount.pass &&
      moneyLossIndicator.pass;

    return {
      windowDays: 30,
      generatedAt: now.toISOString(),
      paymentTechnicalSuccessRate: { ...paymentTechnicalSuccessRate, prepayUnknown },
      duplicateChargeCount: duplicateCharge,
      unresolvedReconciliationDifferences,
      refundCompletionRate,
      severeIncidentCount,
      moneyLossIndicator,
      /** 待投递/可重试却积压的通知事件；正常应为 0（投递 Cron 每 30 秒跑一次） */
      outboxBacklog: outboxStuck,
      /** 重试耗尽、已永久放弃的通知事件；不为 0 说明有业主该收到的通知彻底丢了 */
      outboxExhausted,
      /** 近 30 日发送失败的通知条数（含业主未授权，保留原口径） */
      notifyFailedCount: notifyFailed,
      /**
       * 其中「业主未授权/额度用尽」（微信 43101）的条数。
       * 这类不是故障：一次性订阅授权一次只能收一条，需要引导业主再次授权，
       * 而不是去查系统。
       */
      notifyUnauthorizedCount: notifyUnauthorized,
      /**
       * 真正需要人处理的通知失败 = 总数 - 未授权。
       * 不为 0 才说明模板配置、openid 或网络出了问题。
       */
      notifySystemFailedCount: Math.max(0, notifyFailed - notifyUnauthorized),
      overallPass,
      daily: dailyRows.map((r) => {
        const success = Number(r.success);
        const total = Number(r.total);
        return { day: r.day, success, total, rate: total === 0 ? 1 : success / total };
      }),
    };
  }

  private async dailyPaymentSuccess(tenantId: string, communityId: string | null, since: Date): Promise<DailyRow[]> {
    const communityClause = communityId ? Prisma.sql`AND \`communityId\` = ${communityId}` : Prisma.empty;
    return this.prisma.raw.$queryRaw<DailyRow[]>(Prisma.sql`
      SELECT DATE(\`createdAt\`) AS \`day\`,
             -- REFUNDED 也算当时成功过；口径必须与上面的聚合一致，
             -- 否则「总体成功率」与「每日曲线」会讲两个故事
             SUM(CASE WHEN \`status\` IN ('SUCCESS','REFUNDED') THEN 1 ELSE 0 END) AS \`success\`,
             SUM(CASE WHEN \`status\` IN ('SUCCESS','REFUNDED','FAILED') THEN 1 ELSE 0 END) AS \`total\`
      FROM \`Payment\`
      WHERE \`tenantId\` = ${tenantId}
        AND \`channel\` = 'WXPAY'
        AND \`createdAt\` >= ${since}
        ${communityClause}
      GROUP BY DATE(\`createdAt\`)
      ORDER BY \`day\` ASC
    `);
  }
}
