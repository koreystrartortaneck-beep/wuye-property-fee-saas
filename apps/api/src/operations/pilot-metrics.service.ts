import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
    ] = await Promise.all([
      this.prisma.t.payment.count({ where: { status: 'SUCCESS', createdAt: { gte: since }, ...cf } }),
      this.prisma.t.payment.count({ where: { status: { in: ['FAILED'] }, createdAt: { gte: since }, ...cf } }),
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
             SUM(CASE WHEN \`status\` = 'SUCCESS' THEN 1 ELSE 0 END) AS \`success\`,
             SUM(CASE WHEN \`status\` IN ('SUCCESS','FAILED') THEN 1 ELSE 0 END) AS \`total\`
      FROM \`Payment\`
      WHERE \`tenantId\` = ${tenantId}
        AND \`createdAt\` >= ${since}
        ${communityClause}
      GROUP BY DATE(\`createdAt\`)
      ORDER BY \`day\` ASC
    `);
  }
}
