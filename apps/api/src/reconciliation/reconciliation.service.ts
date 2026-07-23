import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ErrorCode, ReconciliationBillType, ReconciliationDifferenceType, ReconciliationItemStatus } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { toCents } from '../billing/engine/money';
import { BizException } from '../common/biz.exception';
import { AlertService } from '../operations/alert.service';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';
import { ChannelBill, WECHAT_BILL_PROVIDER, WechatBillProvider, shanghaiBillingDate } from './wechat-bill.provider';

/** 对账过程中用于自动本地确认的支付恢复协作者（PaymentService 实现）。 */
export const RECON_RECOVERY = Symbol('RECON_RECOVERY');
export interface ReconRecovery {
  resolveActiveOrder(orderNo: string): Promise<{ orderNo: string; status: string } | null>;
}

const LEASE_MS = 5 * 60 * 1000;

export interface ReconcileInput {
  tenantId: string;
  communityId?: string | null;
  merchantAccountId: string;
  mchid: string;
  appid: string;
  businessDate: string | Date;
  billType: ReconciliationBillType;
  workerId?: string;
  adminId?: string | null;
}

interface DifferenceDraft {
  orderNo: string;
  differenceType: ReconciliationDifferenceType;
  status: ReconciliationItemStatus;
  paymentId?: string | null;
  refundId?: string | null;
  localAmount?: string | null;
  channelAmount?: string | null;
  localStatus?: string | null;
  channelStatus?: string | null;
  channelTransactionId?: string | null;
}

/**
 * 微信支付每日自动对账：下载渠道对账单 → 与本地流水比对 → 落 5 类差异项 ReconciliationItem。
 * - 每商户每账期每类型唯一 Run；重复运行幂等；多实例租约防并发重复；
 * - 渠道成功但本地未终态 → 触发恢复查单自动本地确认（AUTO_RESOLVED）；
 * - 手工处置差异；全程写审计；不落渠道敏感明文。
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger('Reconciliation');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(WECHAT_BILL_PROVIDER) private readonly billProvider: WechatBillProvider,
    @Optional() @Inject(RECON_RECOVERY) private readonly recovery: ReconRecovery | null = null,
    @Optional() private readonly alerts: AlertService | null = null,
  ) {}

  private runNo(merchantAccountId: string, businessDate: string, billType: string): string {
    return `RC-${businessDate}-${billType}-${merchantAccountId}`;
  }

  /** 每日 10:30 自动对账昨日账期（微信对账单有出单延迟）；仅 wxpay 且配置了商户范围时执行。 */
  @Cron('0 30 10 * * *')
  async runDaily(now: Date = new Date()): Promise<void> {
    if (process.env.PAY_MODE !== 'wxpay') return;
    const tenantId = process.env.WX_PAY_ALLOWED_TENANT_ID;
    const communityId = process.env.WX_PAY_ALLOWED_COMMUNITY_ID ?? null;
    const merchantAccountId = process.env.WX_PAY_MERCHANT_SERIAL;
    const mchid = process.env.WX_PAY_MCH_ID;
    const appid = process.env.WX_PAY_APP_ID ?? process.env.WX_APPID;
    if (!tenantId || !merchantAccountId || !mchid || !appid) return;
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const businessDate = shanghaiBillingDate(yesterday);
    for (const billType of ['TRANSACTION', 'REFUND'] as ReconciliationBillType[]) {
      try {
        await this.reconcile({ tenantId, communityId, merchantAccountId, mchid, appid, businessDate, billType });
      } catch (error) {
        this.logger.warn(`每日对账失败 ${businessDate} ${billType}: ${error instanceof Error ? error.message : error}`);
        if (this.alerts) {
          await this.alerts.safeEmit({
            tenantId,
            communityId,
            alertType: 'SCHEDULER_FAILURE',
            severity: 'CRITICAL',
            dedupKey: `SCHEDULER_FAILURE:reconcile:${businessDate}:${billType}`,
            title: '每日对账任务执行失败',
            summary: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /** 领取或创建当日对账 Run；重复完成幂等返回；多实例租约防并发。 */
  private async claimRun(input: ReconcileInput, businessDate: string, workerId: string) {
    const existing = await this.prisma.raw.reconciliationRun.findFirst({
      where: { merchantAccountId: input.merchantAccountId, businessDate: new Date(`${businessDate}T00:00:00.000Z`), billType: input.billType },
    });
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    if (existing) {
      if (existing.status === 'COMPLETED') return { run: existing, done: true as const };
      // RUNNING：租约未过期且属于他人 → 跳过。
      if (existing.leaseExpiresAt && existing.leaseExpiresAt > now && existing.leaseOwner !== workerId) {
        return { run: existing, busy: true as const };
      }
      const claimed = await this.prisma.raw.reconciliationRun.updateMany({
        where: { id: existing.id, status: 'RUNNING' },
        data: { leaseOwner: workerId, leaseExpiresAt, startedAt: now },
      });
      if (claimed.count !== 1) return { run: existing, busy: true as const };
      return { run: existing, done: false as const };
    }
    try {
      const run = await this.prisma.raw.reconciliationRun.create({
        data: {
          tenantId: input.tenantId,
          communityId: input.communityId ?? null,
          runNo: this.runNo(input.merchantAccountId, businessDate, input.billType),
          merchantAccountId: input.merchantAccountId,
          mchid: input.mchid,
          appid: input.appid,
          channel: 'WXPAY',
          businessDate: new Date(`${businessDate}T00:00:00.000Z`),
          billType: input.billType,
          status: 'RUNNING',
          leaseOwner: workerId,
          leaseExpiresAt,
          createdBy: input.adminId ?? null,
        },
      });
      return { run, done: false as const };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        const raced = await this.prisma.raw.reconciliationRun.findFirst({
          where: { merchantAccountId: input.merchantAccountId, businessDate: new Date(`${businessDate}T00:00:00.000Z`), billType: input.billType },
        });
        if (raced) return { run: raced, busy: true as const };
      }
      throw error;
    }
  }

  async reconcile(input: ReconcileInput): Promise<{ runId: string; status: string; differenceRecordCount: number }> {
    const businessDate = typeof input.businessDate === 'string' ? input.businessDate : shanghaiBillingDate(input.businessDate);
    const workerId = input.workerId ?? `recon-${process.pid}`;

    return runWithTenant(input.tenantId, async () => {
      const claim = await this.claimRun(input, businessDate, workerId);
      if ('done' in claim && claim.done) {
        return { runId: claim.run.id, status: 'COMPLETED', differenceRecordCount: claim.run.differenceRecordCount };
      }
      if ('busy' in claim && claim.busy) {
        return { runId: claim.run.id, status: claim.run.status, differenceRecordCount: claim.run.differenceRecordCount };
      }
      const run = claim.run;

      try {
        const bill = await this.billProvider.downloadBill({
          merchantAccountId: input.merchantAccountId,
          mchid: input.mchid,
          appid: input.appid,
          businessDate,
          billType: input.billType,
        });
        const drafts =
          input.billType === 'REFUND'
            ? await this.compareRefunds(input, businessDate, bill)
            : await this.compareTrades(input, businessDate, bill);

        const localTotals = await this.localTotals(input, businessDate, input.billType);
        await this.persist(input, run.id, bill, drafts, localTotals, workerId);
        const openCount = drafts.filter((d) => d.status === 'OPEN' || d.status === 'ESCALATED').length;
        if (this.alerts && openCount > 0) {
          await this.alerts.safeEmit({
            tenantId: input.tenantId,
            communityId: input.communityId ?? null,
            alertType: 'RECONCILIATION_DIFFERENCE',
            severity: 'CRITICAL',
            dedupKey: `RECONCILIATION_DIFFERENCE:${businessDate}:${input.billType}`,
            title: '对账存在未处置差异',
            summary: `账期 ${businessDate} ${input.billType} 存在 ${openCount} 条差异`,
          });
        }
        return { runId: run.id, status: 'COMPLETED', differenceRecordCount: openCount };
      } catch (error) {
        await this.prisma.raw.reconciliationRun.updateMany({
          where: { id: run.id, status: 'RUNNING' },
          data: { status: 'FAILED', leaseOwner: null, leaseExpiresAt: null, errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 191), finishedAt: new Date() },
        });
        throw error;
      }
    });
  }

  private async compareTrades(input: ReconcileInput, businessDate: string, bill: ChannelBill): Promise<DifferenceDraft[]> {
    const drafts: DifferenceDraft[] = [];
    const localSuccess = await this.prisma.raw.payment.findMany({
      where: { tenantId: input.tenantId, channel: 'WXPAY', status: { in: ['SUCCESS', 'REFUNDED'] } },
      select: { id: true, orderNo: true, totalAmount: true, status: true, paidAt: true },
    });
    const localOnDate = localSuccess.filter((p) => p.paidAt && shanghaiBillingDate(p.paidAt) === businessDate);
    const channelByOrder = new Map(bill.trades.map((t) => [t.outTradeNo, t]));
    const localByOrder = new Map(localOnDate.map((p) => [p.orderNo, p]));

    for (const ch of bill.trades) {
      const local = localByOrder.get(ch.outTradeNo) ?? (await this.findPayment(input.tenantId, ch.outTradeNo));
      if (!local) {
        drafts.push({ orderNo: ch.outTradeNo, differenceType: 'LOCAL_MISSING', status: 'OPEN', channelAmount: (ch.amountCents / 100).toFixed(2), channelStatus: ch.tradeState, channelTransactionId: ch.transactionId });
        continue;
      }
      const localCents = toCents(String(local.totalAmount));
      if (localCents !== ch.amountCents) {
        drafts.push({ orderNo: ch.outTradeNo, differenceType: 'AMOUNT_MISMATCH', status: 'OPEN', paymentId: local.id, localAmount: (localCents / 100).toFixed(2), channelAmount: (ch.amountCents / 100).toFixed(2), localStatus: local.status, channelStatus: ch.tradeState });
        continue;
      }
      if (ch.tradeState === 'SUCCESS' && !['SUCCESS', 'REFUNDED'].includes(local.status)) {
        // 渠道成功但本地未终态：触发恢复查单自动本地确认。
        let resolved = false;
        if (this.recovery) {
          try {
            const r = await this.recovery.resolveActiveOrder(ch.outTradeNo);
            resolved = r?.status === 'SUCCESS';
          } catch (e) {
            this.logger.warn(`对账自动确认失败 order=${ch.outTradeNo}: ${e instanceof Error ? e.message : e}`);
          }
        }
        drafts.push({ orderNo: ch.outTradeNo, differenceType: 'STATUS_MISMATCH', status: resolved ? 'AUTO_RESOLVED' : 'OPEN', paymentId: local.id, localStatus: local.status, channelStatus: ch.tradeState, channelTransactionId: ch.transactionId });
      }
    }
    for (const p of localOnDate) {
      if (!channelByOrder.has(p.orderNo)) {
        drafts.push({ orderNo: p.orderNo, differenceType: 'CHANNEL_MISSING', status: 'OPEN', paymentId: p.id, localAmount: String(p.totalAmount), localStatus: p.status });
      }
    }
    return drafts;
  }

  private async compareRefunds(input: ReconcileInput, businessDate: string, bill: ChannelBill): Promise<DifferenceDraft[]> {
    const drafts: DifferenceDraft[] = [];
    const localRefunds = await this.prisma.raw.refund.findMany({
      where: { tenantId: input.tenantId, channel: 'WXPAY', status: 'SUCCESS' },
      select: { id: true, refundNo: true, refundAmount: true, status: true, refundedAt: true },
    });
    const localOnDate = localRefunds.filter((r) => r.refundedAt && shanghaiBillingDate(r.refundedAt) === businessDate);
    const channelByRefund = new Map(bill.refunds.map((r) => [r.outRefundNo, r]));
    const localByRefund = new Map(localOnDate.map((r) => [r.refundNo, r]));

    for (const ch of bill.refunds) {
      const local = localByRefund.get(ch.outRefundNo) ?? (await this.findRefund(input.tenantId, ch.outRefundNo));
      if (!local) {
        drafts.push({ orderNo: ch.outRefundNo, differenceType: 'LOCAL_MISSING', status: 'OPEN', channelAmount: (ch.refundCents / 100).toFixed(2), channelStatus: ch.refundState });
        continue;
      }
      const localCents = toCents(String(local.refundAmount));
      if (localCents !== ch.refundCents || (ch.refundState === 'SUCCESS' && local.status !== 'SUCCESS')) {
        drafts.push({ orderNo: ch.outRefundNo, differenceType: 'REFUND_MISMATCH', status: 'OPEN', refundId: local.id, localAmount: (localCents / 100).toFixed(2), channelAmount: (ch.refundCents / 100).toFixed(2), localStatus: local.status, channelStatus: ch.refundState });
      }
    }
    for (const r of localOnDate) {
      if (!channelByRefund.has(r.refundNo)) {
        drafts.push({ orderNo: r.refundNo, differenceType: 'CHANNEL_MISSING', status: 'OPEN', refundId: r.id, localAmount: String(r.refundAmount), localStatus: r.status });
      }
    }
    return drafts;
  }

  private async findPayment(tenantId: string, orderNo: string) {
    return this.prisma.raw.payment.findFirst({ where: { tenantId, orderNo }, select: { id: true, orderNo: true, totalAmount: true, status: true, paidAt: true } });
  }

  private async findRefund(tenantId: string, refundNo: string) {
    return this.prisma.raw.refund.findFirst({ where: { tenantId, refundNo }, select: { id: true, refundNo: true, refundAmount: true, status: true, refundedAt: true } });
  }

  private async localTotals(input: ReconcileInput, businessDate: string, billType: ReconciliationBillType): Promise<{ count: number; cents: number }> {
    if (billType === 'REFUND') {
      const refunds = await this.prisma.raw.refund.findMany({ where: { tenantId: input.tenantId, channel: 'WXPAY', status: 'SUCCESS' }, select: { refundAmount: true, refundedAt: true } });
      const onDate = refunds.filter((r) => r.refundedAt && shanghaiBillingDate(r.refundedAt) === businessDate);
      return { count: onDate.length, cents: onDate.reduce((s, r) => s + toCents(String(r.refundAmount)), 0) };
    }
    const payments = await this.prisma.raw.payment.findMany({ where: { tenantId: input.tenantId, channel: 'WXPAY', status: { in: ['SUCCESS', 'REFUNDED'] } }, select: { totalAmount: true, paidAt: true } });
    const onDate = payments.filter((p) => p.paidAt && shanghaiBillingDate(p.paidAt) === businessDate);
    return { count: onDate.length, cents: onDate.reduce((s, p) => s + toCents(String(p.totalAmount)), 0) };
  }

  private async persist(
    input: ReconcileInput,
    runId: string,
    bill: ChannelBill,
    drafts: DifferenceDraft[],
    localTotals: { count: number; cents: number },
    workerId: string,
  ): Promise<void> {
    // 与 reconcile() 返回口径一致：未决差异 = OPEN + ESCALATED（AUTO_RESOLVED 不计）
    const openCount = drafts.filter((d) => d.status === 'OPEN' || d.status === 'ESCALATED').length;
    const diffCents = drafts.reduce((s, d) => s + Math.abs(toCents(d.channelAmount ?? '0') - toCents(d.localAmount ?? '0')), 0);
    await this.prisma.raw.$transaction(async (tx) => {
      for (const d of drafts) {
        try {
          await tx.reconciliationItem.create({
            data: {
              tenantId: input.tenantId,
              communityId: input.communityId ?? null,
              runId,
              paymentId: d.paymentId ?? null,
              refundId: d.refundId ?? null,
              orderNo: d.orderNo,
              differenceType: d.differenceType,
              status: d.status,
              localAmount: d.localAmount ?? null,
              channelAmount: d.channelAmount ?? null,
              differenceAmount: null,
              localStatus: d.localStatus ?? null,
              channelStatus: d.channelStatus ?? null,
              channelTransactionId: d.channelTransactionId ?? null,
            },
          });
        } catch (error) {
          if ((error as { code?: string }).code !== 'P2002') throw error; // 幂等：同差异项已存在
        }
      }
      await tx.reconciliationRun.updateMany({
        where: { id: runId },
        data: {
          status: 'COMPLETED',
          channelFileHash: bill.fileHash,
          channelRecordCount: bill.recordCount,
          channelAmount: (bill.totalAmountCents / 100).toFixed(2),
          localRecordCount: localTotals.count,
          localAmount: (localTotals.cents / 100).toFixed(2),
          // 匹配数只减「对应渠道记录」的差异；CHANNEL_MISSING 为本地独有、不在渠道对账单内，不参与扣减
          matchedRecordCount: Math.max(
            0,
            bill.recordCount - drafts.filter((d) => d.differenceType !== 'CHANNEL_MISSING').length,
          ),
          differenceRecordCount: openCount,
          differenceAmount: (diffCents / 100).toFixed(2),
          leaseOwner: null,
          leaseExpiresAt: null,
          finishedAt: new Date(),
        },
      });
      await this.audit.append(
        {
          tenantId: input.tenantId,
          communityId: input.communityId ?? null,
          actorType: input.adminId ? 'ADMIN' : 'SYSTEM',
          actorId: input.adminId ?? null,
          action: 'RECONCILE',
          resourceType: 'ReconciliationRun',
          resourceId: runId,
          afterSummary: { businessDate: bill.businessDate, billType: bill.billType, differences: openCount, channelRecords: bill.recordCount, worker: workerId },
        },
        tx,
      );
    });
  }

  /** 手工处置差异项：MANUALLY_CLOSED / ESCALATED，写审计。 */
  async resolveItem(input: { itemId: string; adminId: string; actingTenantId: string | null; status: 'MANUALLY_CLOSED' | 'ESCALATED'; remark?: string }) {
    const item = await this.prisma.raw.reconciliationItem.findUnique({ where: { id: input.itemId } });
    if (!item) throw new BizException(ErrorCode.NOT_FOUND, '对账差异项不存在');
    if (input.actingTenantId !== null && input.actingTenantId !== item.tenantId) {
      throw new BizException(ErrorCode.FORBIDDEN, '无权处置该差异项');
    }
    return runWithTenant(item.tenantId, async () => {
      return this.prisma.raw.$transaction(async (tx) => {
        const updated = await tx.reconciliationItem.updateMany({
          where: { id: input.itemId, status: { in: ['OPEN', 'ESCALATED'] } },
          data: { status: input.status, handledBy: input.adminId, handledAt: new Date(), handlingRemark: input.remark ?? null },
        });
        if (updated.count !== 1) throw new BizException(ErrorCode.VALIDATION, '差异项状态不允许该处置');
        await this.audit.append(
          {
            tenantId: item.tenantId,
            communityId: item.communityId,
            actorType: 'ADMIN',
            actorId: input.adminId,
            action: 'RECONCILE',
            resourceType: 'ReconciliationItem',
            resourceId: input.itemId,
            reason: input.remark ?? null,
            afterSummary: { status: input.status },
          },
          tx,
        );
        return { itemId: input.itemId, status: input.status };
      });
    });
  }
}
