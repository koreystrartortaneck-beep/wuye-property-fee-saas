import { Inject, Injectable, Optional, Logger } from '@nestjs/common';
import { PaymentChannel, PaymentStatus, Prisma } from '@prisma/client';
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
/**
 * 可查单/可推进终态的状态集合。
 * 必须包含 FAILED/ABNORMAL：本地失败但微信侧可能已成功退款，
 * 若守卫只认 CREATED/PROCESSING，这类退款会永远停在失败态、
 * 账单仍显示已缴，形成「钱出了账目没动」的窟窿。
 */
const QUERYABLE_REFUND_STATUSES = ['CREATED', 'PROCESSING', 'FAILED', 'ABNORMAL'] as const;

export interface CreateRefundInput {
  orderNo: string;
  adminId: string;
  actingTenantId: string | null;
  reason: string;
  requestId: string;
}

/*
 * 这些字段原本把金额写成 unknown、渠道写成 string，于是写入 Refund 时不得不用
 * `as never` 把类型检查全部关掉 —— 金额字段放弃类型检查是这个系统里最不该做的事。
 * 按真实列类型声明后，as never 就不需要了，写错也会在编译期被拦住。
 */
interface PaymentForRefund {
  id: string;
  tenantId: string;
  communityId: string | null;
  billId: string | null;
  orderNo: string;
  status: PaymentStatus;
  channel: PaymentChannel;
  transactionId: string | null;
  totalAmount: Prisma.Decimal;
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
  private readonly logger = new Logger(RefundService.name);

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
    if (existing) {
      // FAILED 聚合必须先「复活」为 PROCESSING 再外呼。
      // 否则：管理员在失败（如商户余额不足）后重试 → 微信这次受理并成功 →
      // finalizeSuccess/finalizeFailure 的守卫只认 CREATED/PROCESSING，
      // count=0 静默返回 → 钱已退给业主，而库里仍是 Payment=SUCCESS、
      // Bill=PAID、Refund=FAILED，收据不作废、还能继续开票。
      if (existing.status === 'FAILED' || existing.status === 'ABNORMAL') {
        const revived = await this.prisma.raw.$transaction(async (tx) => {
          const r = await tx.refund.updateMany({
            where: { id: existing.id, status: { in: ['FAILED', 'ABNORMAL'] } },
            data: { status: 'PROCESSING', failureCode: null, failureMessage: null, failedAt: null },
          });
          if (r.count === 0) return false;
          // 重新锁定账单，保持与首次发起一致的对外状态
          await tx.bill.updateMany({
            where: { paymentId: payment.id, status: 'PAID' },
            data: { status: 'REFUNDING' },
          });
          return true;
        });
        if (revived) {
          return { ...existing, status: 'PROCESSING', transactionId: payment.transactionId };
        }
      }
      return { ...existing, transactionId: payment.transactionId };
    }

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
          // 金额字段绝不用 as never：那等于放弃对金额类型的一切检查。
          // 列是 Decimal(10,2)，payment.totalAmount 本身就是 Decimal，直接传。
          originalAmount: payment.totalAmount,
          refundAmount: payment.totalAmount,
          currency: 'CNY',
          reason,
          channel: payment.channel,
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
        where: { id: refund.id, status: { in: [...QUERYABLE_REFUND_STATUSES] } },
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
      /*
       * 退款成功等于这笔交易被撤销，当时抵扣的优惠券必须退还业主。
       *
       * releaseCouponFor 的注释本来就写着「订单未成交**或已退款**时」，但它只在
       * finishUnpaidPayment（关闭/失败）里被调用过，退款路径漏了——业主用券付款后
       * 被退款，钱退回来了、券却永久没收。而物业退款多半是因为账单开错，重开后
       * 业主要再付一次，那张券已经没了。
       *
       * 放在本事务内保证与退款终态原子；条件 status: 'USED' 保证幂等
       * （重复调用不会把业主已重新用掉的券再改回 UNUSED）。
       */
      const paid = await tx.payment.findUnique({
        where: { id: refund.paymentId },
        select: { userCouponId: true },
      });
      if (paid?.userCouponId) {
        await tx.userCoupon.updateMany({
          where: { id: paid.userCouponId, status: 'USED' },
          data: { status: 'UNUSED', usedAt: null },
        });
      }
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

  /**
   * 恢复任务：以稳定 refundNo 查单并推进终态。
   * 允许对 FAILED/ABNORMAL 也查单——微信侧可能已实际退款成功
   * （商户平台人工重发、或受理后异步转成功），若不查就永远对不上账。
   */
  async recoverRefund(refundNo: string): Promise<{ refundNo: string; status: string } | null> {
    const refund = (await this.prisma.raw.refund.findUnique({ where: { refundNo } })) as RefundAggregate | null;
    if (!refund || !(QUERYABLE_REFUND_STATUSES as readonly string[]).includes(refund.status)) {
      return refund ? { refundNo, status: refund.status } : null;
    }
    if (!this.provider.queryRefund) throw new Error('当前支付渠道不支持退款查询');
    const result = await this.provider.queryRefund(refundNo);
    await this.prisma.raw.refund.updateMany({ where: { id: refund.id }, data: { lastQueriedAt: new Date() } });

    return runWithTenant(refund.tenantId, async () => {
      if (result.status === 'SUCCESS') {
        await this.finalizeSuccess(refund, result);
        /*
         * 查单确认的也要留一条事件。
         *
         * 原来只有回调到达时写（recordRefundEvidence），查单确认不写。
         * 于是**回调没来、靠查单补回的退款，溯源时间线是空的** ——
         * 而 2026-08-01 之后每一笔退款都是这样。生产实测三笔退款事件全是 0 条。
         * 时间线空着，看的人无从判断「是没发生过，还是没记录」。
         */
        await this.recordQueryEvidence(refund, result);
        return { refundNo, status: 'SUCCESS' };
      }
      if (result.status === 'CLOSED' || result.status === 'ABNORMAL') {
        await this.finalizeFailure(refund, result.status, `退款查单状态 ${result.status}`);
        return { refundNo, status: 'FAILED' };
      }
      return { refundNo, status: 'PROCESSING' };
    });
  }

  /** 记录「靠查单确认」的退款事件；与回调证据用不同的 eventKey，两者可以并存 */
  private async recordQueryEvidence(refund: RefundAggregate, result: WxPayRefund): Promise<void> {
    const eventKey = `refund-query:${refund.refundNo}:${result.refund_id}`;
    try {
      await this.prisma.raw.paymentEvent.upsert({
        where: { tenantId_eventKey: { tenantId: refund.tenantId, eventKey } },
        create: {
          tenantId: refund.tenantId,
          communityId: refund.communityId,
          paymentId: refund.paymentId,
          refundId: refund.id,
          eventKey,
          type: 'REFUNDED',
          status: 'PROCESSED',
          source: 'WXPAY_QUERY',
          summary: { refundNo: refund.refundNo, refundId: result.refund_id, status: result.status },
          occurredAt: result.success_time ? new Date(result.success_time) : new Date(),
          processedAt: new Date(),
        },
        update: {},
      });
    } catch (error) {
      /*
       * 写痕迹失败不能影响退款已经成功这个事实。但要留日志 ——
       * 否则「痕迹机制自己坏了」又成了一个看不见的故障。
       */
      this.logger.error(
        `退款查单痕迹写入失败 refund=${refund.refundNo}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

  /**
   * 退款溯源：回答「钱退到了吗 / 怎么确认的 / 微信回调到过吗 / 卡住的话为什么」。
   *
   * 2026-08-01 的教训：一笔 ¥1 的退款微信 3 秒就退完了、业主微信里已到账，
   * 而后台显示「退款中」整整 10 分钟 —— 因为**退款回调一次都没到**，
   * 全靠 10 分钟一轮的查单兜底才对齐。而那 10 分钟里，后台只能看到一个
   * PROCESSING：看不出微信到底退没退、看不出回调有没有来、也没有任何按钮能推一把。
   *
   * 支付侧已经补过同样的能力（/admin/payments/trace + force-sync），
   * 退款侧当时漏了。这个方法是退款侧的对应物。
   */
  async trace(orderNo: string, actingTenantId?: string | null) {
    const refund = await this.prisma.raw.refund.findFirst({
      where: {
        paymentOrderNo: orderNo,
        ...(actingTenantId ? { tenantId: actingTenantId } : {}),
      },
      include: { attempts: { orderBy: { attemptNo: 'asc' } } },
    });
    if (!refund) throw new BizException(ErrorCode.NOT_FOUND);

    const events = await this.prisma.raw.paymentEvent.findMany({
      where: { refundId: refund.id },
      orderBy: { occurredAt: 'asc' },
      select: {
        type: true, status: true, source: true, occurredAt: true,
        processedAt: true, attempts: true, lastError: true, summary: true,
      },
      take: 50,
    });

    return {
      ...refund,
      /*
       * 明确给出结论，而不是让人对着一堆时间戳自己推。
       *
       * via 是**派生**的，不是存下来的：Refund 表没有 confirmedBy 这样的列，
       * 而 finalizeSuccess 既可能由回调触发、也可能由查单触发。
       * 判据：回调到过（notifyReceivedAt 有值）就算回调确认，否则是查单补回的。
       * 「一直靠查单补回」本身就是需要上报的运维事实 —— 说明回调链路没通。
       */
      settlement: {
        done: refund.status === 'SUCCESS',
        via:
          refund.status === 'SUCCESS'
            ? refund.notifyReceivedAt
              ? 'WXPAY_NOTIFY'
              : 'WXPAY_QUERY'
            : null,
        wxCallbackArrived: refund.notifyReceivedAt !== null,
        queriedAt: refund.lastQueriedAt,
      },
      events,
    };
  }

  /**
   * 立即向微信查一次退款状态。
   *
   * 退款侧原来只有 2 分钟一轮的 cron（改之前是 10 分钟）。业主打电话说
   * 「钱到了/没到」时，收费员需要当场就能核实，而不是回一句「你再等等」。
   * 支付侧的对应物是 force-sync。
   */
  async forceQuery(orderNo: string, actingTenantId?: string | null) {
    const refund = await this.prisma.raw.refund.findFirst({
      where: { paymentOrderNo: orderNo },
      select: { refundNo: true, tenantId: true, status: true },
    });
    /*
     * 跨租户防护要显式。查单按 refundNo 走 prisma.raw（回调与 cron 都没有租户
     * 上下文，只能这样），所以这里必须自己比对；用 NOT_FOUND 而非 FORBIDDEN，
     * 不向调用方确认这个订单号存在。
     */
    if (!refund || (actingTenantId && refund.tenantId !== actingTenantId)) {
      throw new BizException(ErrorCode.NOT_FOUND);
    }
    const result = await this.recoverRefund(refund.refundNo);
    return result ?? { refundNo: refund.refundNo, status: refund.status };
  }

  /** 按订单号查退款。actingTenantId 非空（租户管理员）时强制限定本租户，防跨租户越权读取；
   *  null 表示平台超管，可跨租户查看。 */
  async getRefund(orderNo: string, actingTenantId?: string | null) {
    const refund = await this.prisma.raw.refund.findFirst({
      where: {
        paymentOrderNo: orderNo,
        ...(actingTenantId ? { tenantId: actingTenantId } : {}),
      },
      include: { attempts: { orderBy: { attemptNo: 'asc' } } },
    });
    if (!refund) throw new BizException(ErrorCode.NOT_FOUND);
    return refund;
  }
}
