import { Inject, Injectable, Optional } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { toCents } from '../billing/engine/money';
import { BizException } from '../common/biz.exception';
import { IdempotencyService } from '../common/idempotency.service';
import { hashCanonicalJson } from '../common/idempotency.service';
import { INVOICE_REFUND_LINK, InvoiceRefundLink } from '../invoice/invoice.service';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';
import { PAYMENT_PROVIDER, PaymentProvider, PaymentProviderError, WxPayRefund } from './provider';

/** 进行中的退款聚合状态（可继续查单/恢复） */
const OPEN_REFUND_STATUSES = ['CREATED', 'PROCESSING'] as const;

export interface CreateRefundInput {
  orderNo: string;
  adminId: string;
  actingTenantId: string | null;
  reason: string;
  requestId: string;
}

interface PaymentForRefund {
  id: string;
  tenantId: string;
  communityId: string | null;
  billId: string | null;
  orderNo: string;
  status: string;
  channel: string;
  transactionId: string | null;
  totalAmount: unknown;
  mchid: string | null;
  appid: string | null;
  merchantAccountId: string | null;
  paymentBills: Array<{ billId: string; bill: { communityId: string } }>;
}

interface RefundAggregate {
  id: string;
  tenantId: string;
  communityId: string | null;
  paymentId: string;
  paymentOrderNo: string;
  refundNo: string;
  status: string;
  originalAmount: unknown;
  refundAmount: unknown;
  reason: string;
  channel: string;
  providerRefundId: string | null;
  transactionId?: string | null;
}

/**
 * 微信全额退款闭环：单账单/单聚合（每笔支付一个 Refund）。
 * - 金额由订单派生，不接受客户端传入；
 * - RefundAttempt 记录每次外呼，requestNo 稳定以支持中断恢复；
 * - 明确失败恢复账单 PAID；成功锁定 REFUNDED；回调/查单/恢复共用幂等终态逻辑。
 */
@Injectable()
export class RefundService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    @Optional() @Inject(INVOICE_REFUND_LINK) private readonly invoiceLink?: InvoiceRefundLink,
  ) {}

  private refundNoFor(orderNo: string): string {
    return `RF-${orderNo}`;
  }

  private resolveCommunityId(payment: PaymentForRefund): string | null {
    if (payment.communityId) return payment.communityId;
    // 历史订单：从 PaymentBill 派生小区集合；跨小区保持 null。
    const set = new Set(payment.paymentBills.map((pb) => pb.bill.communityId));
    return set.size === 1 ? [...set][0] : null;
  }

  /** 管理端发起全额退款（幂等）。 */
  async createRefund(input: CreateRefundInput): Promise<{ refundNo: string; status: string }> {
    const payment = (await this.prisma.raw.payment.findUnique({
      where: { orderNo: input.orderNo },
      include: { paymentBills: { include: { bill: { select: { communityId: true } } } } },
    })) as PaymentForRefund | null;
    if (!payment) throw new BizException(ErrorCode.NOT_FOUND, '订单不存在');
    if (input.actingTenantId !== null && input.actingTenantId !== payment.tenantId) {
      throw new BizException(ErrorCode.FORBIDDEN, '无权对该订单退款');
    }
    if (payment.status === 'REFUNDED') return { refundNo: this.refundNoFor(payment.orderNo), status: 'SUCCESS' };
    if (payment.status !== 'SUCCESS') {
      throw new BizException(ErrorCode.REFUND_STATE_INVALID, '仅已支付成功的订单可退款');
    }
    if (payment.channel !== 'WXPAY') {
      throw new BizException(ErrorCode.REFUND_STATE_INVALID, '仅微信支付订单可发起在线退款');
    }
    if (!this.provider.createRefund) throw new Error('当前支付渠道不支持退款');

    const tenantId = payment.tenantId;
    const communityId = this.resolveCommunityId(payment);

    return runWithTenant(tenantId, async () => {
      const reservation = await this.idempotency.reserve({
        tenantId,
        communityId,
        actorKey: input.adminId,
        action: 'admin.refund.create',
        requestId: input.requestId,
        payload: { orderNo: input.orderNo },
      });
      if (reservation.outcome === 'REPLAY') return reservation.responseBody as { refundNo: string; status: string };
      if (reservation.outcome === 'IN_PROGRESS') {
        throw new BizException(ErrorCode.REFUND_STATE_INVALID, '退款请求处理中，请稍候');
      }
      if (reservation.outcome === 'FAILED') {
        throw new BizException(ErrorCode.REFUND_STATE_INVALID, reservation.errorMessage);
      }

      try {
        const refund = await this.getOrCreateAggregate(payment, communityId, input.adminId, input.reason);
        if (refund.status === 'SUCCESS') {
          const done = { refundNo: refund.refundNo, status: 'SUCCESS' };
          await this.idempotency.complete({ tenantId, recordId: reservation.recordId, responseCode: 0, responseBody: done });
          return done;
        }
        const status = await this.attemptProviderRefund(refund, payment);
        const response = { refundNo: refund.refundNo, status };
        await this.idempotency.complete({ tenantId, recordId: reservation.recordId, responseCode: 0, responseBody: response });
        return response;
      } catch (error) {
        await this.idempotency.fail({
          tenantId,
          recordId: reservation.recordId,
          errorCode: error instanceof BizException ? String(error.code) : 'REFUND_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  /** 幂等取/建退款聚合，并将关联账单置 REFUNDING（事务内写审计）。 */
  private async getOrCreateAggregate(
    payment: PaymentForRefund,
    communityId: string | null,
    adminId: string,
    reason: string,
  ): Promise<RefundAggregate> {
    const existing = (await this.prisma.raw.refund.findUnique({
      where: { paymentId: payment.id },
    })) as RefundAggregate | null;
    if (existing) return { ...existing, transactionId: payment.transactionId };

    const refundNo = this.refundNoFor(payment.orderNo);
    const created = await this.prisma.raw.$transaction(async (tx) => {
      const r = await tx.refund.create({
        data: {
          tenantId: payment.tenantId,
          communityId,
          paymentId: payment.id,
          paymentOrderNo: payment.orderNo,
          billId: payment.billId ?? null,
          merchantAccountId: payment.merchantAccountId ?? process.env.WX_PAY_MERCHANT_SERIAL ?? 'UNKNOWN',
          mchid: payment.mchid ?? process.env.WX_PAY_MCH_ID ?? 'UNKNOWN',
          appid: payment.appid ?? process.env.WX_PAY_APP_ID ?? process.env.WX_APPID ?? 'UNKNOWN',
          refundNo,
          type: 'FULL',
          originalAmount: payment.totalAmount as never,
          refundAmount: payment.totalAmount as never,
          currency: 'CNY',
          reason,
          channel: payment.channel as never,
          status: 'CREATED',
          requestedBy: adminId,
        },
      });
      await tx.bill.updateMany({
        where: { paymentId: payment.id, status: 'PAID' },
        data: { status: 'REFUNDING' },
      });
      await this.audit.append(
        {
          tenantId: payment.tenantId,
          communityId,
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'REFUND',
          resourceType: 'Refund',
          resourceId: r.id,
          reason,
          afterSummary: { refundNo, status: 'CREATED', refundAmount: String(payment.totalAmount) },
        },
        tx,
      );
      return r;
    });
    return { ...(created as RefundAggregate), transactionId: payment.transactionId };
  }

  /** 外呼退款：记录 RefundAttempt，稳定 refundNo；根据渠道结果推进终态。 */
  private async attemptProviderRefund(refund: RefundAggregate, payment: PaymentForRefund): Promise<string> {
    const refundCents = toCents(String(refund.refundAmount));
    const totalCents = toCents(String(refund.originalAmount));
    const attemptNo = (await this.prisma.raw.refundAttempt.count({ where: { refundId: refund.id } })) + 1;
    const requestHash = hashCanonicalJson({ outRefundNo: refund.refundNo, refundCents, totalCents });
    const attempt = await this.prisma.raw.refundAttempt.create({
      data: {
        tenantId: refund.tenantId,
        communityId: refund.communityId,
        refundId: refund.id,
        attemptNo,
        status: 'PENDING',
        requestHash,
        requestSummary: { outRefundNo: refund.refundNo, refundCents, totalCents },
      },
    });
    await this.prisma.raw.refund.updateMany({
      where: { id: refund.id, status: 'CREATED' },
      data: { status: 'PROCESSING', processingAt: new Date() },
    });

    let result: WxPayRefund;
    try {
      result = await this.provider.createRefund!({
        outTradeNo: refund.paymentOrderNo,
        transactionId: payment.transactionId ?? undefined,
        outRefundNo: refund.refundNo,
        totalCents,
        refundCents,
        reason: refund.reason,
        tenantId: refund.tenantId,
      });
    } catch (error) {
      if (error instanceof PaymentProviderError && error.status >= 400 && error.status < 500) {
        // 明确业务拒绝：置失败并恢复账单 PAID。
        await this.prisma.raw.refundAttempt.update({
          where: { id: attempt.id },
          data: { status: 'FAILED', errorCode: error.code, errorMessage: error.message, finishedAt: new Date() },
        });
        await this.finalizeFailure(refund, error.code, error.message);
        throw new BizException(ErrorCode.REFUND_STATE_INVALID, `退款被拒绝：${error.message}`);
      }
      // 网络/超时/5xx：结果不确定，保留 PROCESSING，交由回调或恢复查单裁决。
      await this.prisma.raw.refundAttempt.update({
        where: { id: attempt.id },
        data: { status: 'UNKNOWN', errorMessage: error instanceof Error ? error.message : String(error), finishedAt: new Date() },
      });
      return 'PROCESSING';
    }

    await this.prisma.raw.refundAttempt.update({
      where: { id: attempt.id },
      data: {
        status: result.status === 'SUCCESS' ? 'SUCCESS' : 'PENDING',
        responseSummary: { status: result.status, refundId: result.refund_id },
        finishedAt: new Date(),
      },
    });
    if (result.refund_id) {
      await this.prisma.raw.refund.updateMany({
        where: { id: refund.id, providerRefundId: null },
        data: { providerRefundId: result.refund_id },
      });
    }
    if (result.status === 'SUCCESS') {
      await this.finalizeSuccess(refund, result);
      return 'SUCCESS';
    }
    if (result.status === 'CLOSED' || result.status === 'ABNORMAL') {
      await this.finalizeFailure(refund, result.status, `退款渠道状态 ${result.status}`);
      return 'FAILED';
    }
    return 'PROCESSING';
  }

  /** 成功锁定：Refund SUCCESS、Payment REFUNDED、账单 REFUNDED；幂等。 */
  private async finalizeSuccess(refund: RefundAggregate, result?: WxPayRefund): Promise<void> {
    await this.prisma.raw.$transaction(async (tx) => {
      const updated = await tx.refund.updateMany({
        where: { id: refund.id, status: { in: [...OPEN_REFUND_STATUSES] } },
        data: {
          status: 'SUCCESS',
          refundedAt: result?.success_time ? new Date(result.success_time) : new Date(),
          providerRefundId: result?.refund_id ?? undefined,
        },
      });
      if (updated.count === 0) return; // 幂等：已终态
      await tx.payment.updateMany({
        where: { id: refund.paymentId, status: 'SUCCESS' },
        data: { status: 'REFUNDED' },
      });
      await tx.bill.updateMany({
        where: { paymentId: refund.paymentId, status: { in: ['REFUNDING', 'PAID'] } },
        data: { status: 'REFUNDED' },
      });
      // 退款成功联动开票：未开票申请置 CANCELED，已开票生成冲红任务（同事务原子）。
      if (this.invoiceLink) {
        await this.invoiceLink.onPaymentRefunded(tx, refund.tenantId, refund.paymentId);
      }
      await this.audit.append(
        {
          tenantId: refund.tenantId,
          communityId: refund.communityId,
          actorType: 'SYSTEM',
          action: 'REFUND',
          resourceType: 'Refund',
          resourceId: refund.id,
          afterSummary: { status: 'SUCCESS' },
        },
        tx,
      );
    });
  }

  /** 明确失败：Refund FAILED，账单恢复 PAID，Payment 保持 SUCCESS；幂等。 */
  private async finalizeFailure(refund: RefundAggregate, code: string, message: string): Promise<void> {
    await this.prisma.raw.$transaction(async (tx) => {
      const updated = await tx.refund.updateMany({
        where: { id: refund.id, status: { in: [...OPEN_REFUND_STATUSES] } },
        data: { status: 'FAILED', failedAt: new Date(), failureCode: code, failureMessage: message.slice(0, 191) },
      });
      if (updated.count === 0) return;
      await tx.bill.updateMany({
        where: { paymentId: refund.paymentId, status: 'REFUNDING' },
        data: { status: 'PAID' },
      });
      await this.audit.append(
        {
          tenantId: refund.tenantId,
          communityId: refund.communityId,
          actorType: 'SYSTEM',
          action: 'REFUND',
          resourceType: 'Refund',
          resourceId: refund.id,
          afterSummary: { status: 'FAILED', failureCode: code },
        },
        tx,
      );
    });
  }

  /** 退款回调：验签解密已由 Provider 完成，此处核对金额、记录证据并幂等推进终态。 */
  async handleRefundNotification(result: WxPayRefund): Promise<{ refundNo: string; status: string }> {
    const refund = (await this.prisma.raw.refund.findUnique({
      where: { refundNo: result.out_refund_no },
    })) as RefundAggregate | null;
    if (!refund) throw new Error('退款回调退款单不存在');
    if (result.amount.refund !== toCents(String(refund.refundAmount))) throw new Error('退款回调金额不一致');

    return runWithTenant(refund.tenantId, async () => {
      await this.recordRefundEvidence(refund, result);
      if (result.status === 'SUCCESS') {
        await this.finalizeSuccess(refund, result);
        return { refundNo: refund.refundNo, status: 'SUCCESS' };
      }
      if (result.status === 'CLOSED' || result.status === 'ABNORMAL') {
        await this.finalizeFailure(refund, result.status, `退款回调状态 ${result.status}`);
        return { refundNo: refund.refundNo, status: 'FAILED' };
      }
      return { refundNo: refund.refundNo, status: 'PROCESSING' };
    });
  }

  /** 恢复任务：以稳定 refundNo 查单并推进终态。 */
  async recoverRefund(refundNo: string): Promise<{ refundNo: string; status: string } | null> {
    const refund = (await this.prisma.raw.refund.findUnique({ where: { refundNo } })) as RefundAggregate | null;
    if (!refund || !OPEN_REFUND_STATUSES.includes(refund.status as (typeof OPEN_REFUND_STATUSES)[number])) {
      return refund ? { refundNo, status: refund.status } : null;
    }
    if (!this.provider.queryRefund) throw new Error('当前支付渠道不支持退款查询');
    const result = await this.provider.queryRefund(refundNo);
    await this.prisma.raw.refund.updateMany({ where: { id: refund.id }, data: { lastQueriedAt: new Date() } });

    return runWithTenant(refund.tenantId, async () => {
      if (result.status === 'SUCCESS') {
        await this.finalizeSuccess(refund, result);
        return { refundNo, status: 'SUCCESS' };
      }
      if (result.status === 'CLOSED' || result.status === 'ABNORMAL') {
        await this.finalizeFailure(refund, result.status, `退款查单状态 ${result.status}`);
        return { refundNo, status: 'FAILED' };
      }
      return { refundNo, status: 'PROCESSING' };
    });
  }

  private async recordRefundEvidence(refund: RefundAggregate, result: WxPayRefund): Promise<void> {
    const eventKey = `refund-notify:${refund.refundNo}:${result.refund_id}`;
    await this.prisma.raw.$transaction(async (tx) => {
      const existing = await tx.paymentEvent.findFirst({
        where: { tenantId: refund.tenantId, eventKey },
      });
      if (!existing) {
        await tx.paymentEvent.create({
          data: {
            tenantId: refund.tenantId,
            communityId: refund.communityId,
            paymentId: refund.paymentId,
            refundId: refund.id,
            eventKey,
            type: 'REFUNDED',
            status: 'PROCESSED',
            source: 'WXPAY_NOTIFY',
            summary: { refundNo: refund.refundNo, refundId: result.refund_id, status: result.status, refund: result.amount.refund },
            occurredAt: result.success_time ? new Date(result.success_time) : new Date(),
            processedAt: new Date(),
          },
        });
      }
      await tx.refund.updateMany({
        where: { id: refund.id, notifyReceivedAt: null },
        data: { notifyReceivedAt: new Date() },
      });
    });
  }

  async getRefund(orderNo: string) {
    const refund = await this.prisma.raw.refund.findFirst({
      where: { paymentOrderNo: orderNo },
      include: { attempts: { orderBy: { attemptNo: 'asc' } } },
    });
    if (!refund) throw new BizException(ErrorCode.NOT_FOUND);
    return refund;
  }
}
