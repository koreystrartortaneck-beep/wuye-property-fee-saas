import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { toCents } from '../billing/engine/money';
import { BizException } from '../common/biz.exception';
import { IdempotencyService } from '../common/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';
import { CollectionPolicyService } from './collection-policy.service';
import { PAYMENT_PROVIDER, PaymentProvider, PaymentProviderError, WxPayTransaction } from './provider';

/** 进行中订单（占用账单）的状态集合 */
const ACTIVE_PAYMENT_STATUSES = ['CREATED', 'PREPAY_UNKNOWN'] as const;

interface ReceiptBill {
  title?: string | null;
  period?: string | null;
  amount?: unknown;
  house?: { displayName?: string | null; community?: { name?: string | null } | null } | null;
}
interface ReceiptPayment {
  orderNo: string;
  channel: string;
  totalAmount: unknown;
  paymentBills?: Array<{ bill?: ReceiptBill | null }>;
}

/**
 * 支付服务（业主端，跨租户经绑定校验 → raw client）。
 * 单账单单支付：每笔订单对应一张账单（Payment.billId），同时保留 PaymentBill 以兼容历史多账单读取。
 * 状态机：CREATED →（预下单网络不确定）PREPAY_UNKNOWN → SUCCESS/FAILED/CLOSED；回调与查单幂等入账。
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly collectionPolicy: CollectionPolicyService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
  ) {}

  private resolveChannel(): 'WXPAY' | 'MOCK' {
    return process.env.PAY_MODE === 'wxpay' ? 'WXPAY' : 'MOCK';
  }

  /** 微信支付部署范围校验：预下单前拦截未开通在线支付的租户/小区。 */
  private assertWxPayScope(tenantId: string, communityIds: string[]): void {
    const allowedTenant = process.env.WX_PAY_ALLOWED_TENANT_ID;
    const allowedCommunity = process.env.WX_PAY_ALLOWED_COMMUNITY_ID;
    if (!allowedTenant || !allowedCommunity) {
      throw new Error('微信支付开通范围未配置：WX_PAY_ALLOWED_TENANT_ID / WX_PAY_ALLOWED_COMMUNITY_ID');
    }
    if (tenantId !== allowedTenant || communityIds.some((id) => id !== allowedCommunity)) {
      throw new BizException(ErrorCode.PAYMENT_SCOPE_FORBIDDEN);
    }
  }

  private genOrderNo(): string {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    return `WY${ymd}${rand}`;
  }

  /** 显式微信业务拒绝（4xx）应立即释放账单；网络/超时/5xx 视为结果不确定，保留预占。 */
  private isExplicitPrepayReject(error: unknown): boolean {
    return (
      error instanceof PaymentProviderError && error.status >= 400 && error.status < 500
    );
  }

  private wxPaySnapshot(channel: 'WXPAY' | 'MOCK') {
    if (channel !== 'WXPAY') return { mchid: null, appid: null, merchantAccountId: null };
    return {
      mchid: process.env.WX_PAY_MCH_ID ?? null,
      appid: process.env.WX_PAY_APP_ID ?? process.env.WX_APPID ?? null,
      merchantAccountId: process.env.WX_PAY_MERCHANT_SERIAL ?? null,
    };
  }

  /**
   * 单账单下单：billId 必须属于本人 ACTIVE 绑定房屋、UNPAID、未被进行中订单占用；
   * 以 requestId 做幂等；订单写入 billId/communityId 与金额、商户范围快照，事务内写创建审计。
   */
  async createPayment(ownerId: string, billId: string, requestId: string) {
    if (typeof billId !== 'string' || !billId) {
      throw new BizException(ErrorCode.VALIDATION, '请选择单张账单支付');
    }
    if (typeof requestId !== 'string' || !requestId) {
      throw new BizException(ErrorCode.VALIDATION, '缺少幂等请求标识');
    }

    const bill = await this.prisma.raw.bill.findUnique({ where: { id: billId } });
    if (!bill) throw new BizException(ErrorCode.NOT_FOUND, '账单不存在');

    // 归属校验（安全前置，先于任何幂等/建单动作）。
    const binding = await this.prisma.raw.houseBinding.findFirst({
      where: { wxUserId: ownerId, houseId: bill.houseId, status: 'ACTIVE' },
    });
    if (!binding) throw new BizException(ErrorCode.NO_BINDING);

    const totalCents = toCents(bill.amount.toString());
    const tenantId = bill.tenantId;
    const communityId = bill.communityId;
    const channel = this.resolveChannel();
    if (channel === 'WXPAY') this.assertWxPayScope(tenantId, [communityId]);
    const user = await this.prisma.raw.wxUser.findUnique({ where: { id: ownerId } });

    // 业主流程无租户上下文；进入本单租户上下文以启用幂等与审计。
    return runWithTenant(tenantId, async () => {
      // 幂等复核须早于状态/占用校验：同一 requestId 的重放应返回已存结果，
      // 而不是被自己首个订单产生的占用挡回。
      const reservation = await this.idempotency.reserve({
        tenantId,
        communityId,
        actorKey: ownerId,
        action: 'owner.payment.create',
        requestId,
        payload: { billId },
      });
      if (reservation.outcome === 'REPLAY') return reservation.responseBody;
      if (reservation.outcome === 'IN_PROGRESS') {
        throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '支付请求处理中，请稍候重试');
      }
      if (reservation.outcome === 'FAILED') {
        throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, reservation.errorMessage);
      }

      let payment: { id: string; orderNo: string; totalAmount: unknown };
      try {
        if (bill.status !== 'UNPAID') {
          throw new BizException(ErrorCode.BILL_NOT_PAYABLE, `账单「${bill.title}」状态为 ${bill.status}`);
        }
        // 占用校验：仅进行中订单（CREATED / PREPAY_UNKNOWN）占用账单，历史失败订单不阻挡重试
        const occupied = await this.prisma.raw.paymentBill.findFirst({
          where: { billId, payment: { status: { in: [...ACTIVE_PAYMENT_STATUSES] } } },
        });
        if (occupied) {
          throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '存在进行中的支付，请先完成或等待其关闭');
        }
        payment = await this.prisma.raw.$transaction(async (tx) => {
          // 与账单预占同事务加锁复核分层收款策略，防止并发暂停被绕过。
          await this.collectionPolicy.assertOpenForUpdate(tx, tenantId, [communityId]);
          const p = await tx.payment.create({
            data: {
              tenantId,
              communityId,
              wxUserId: ownerId,
              billId,
              orderNo: this.genOrderNo(),
              totalAmount: (totalCents / 100).toFixed(2),
              channel,
              status: 'CREATED',
              ...this.wxPaySnapshot(channel),
            },
          });
          const reserved = await tx.bill.updateMany({
            where: { id: billId, status: 'UNPAID', paymentId: null },
            data: { paymentId: p.id },
          });
          if (reserved.count !== 1) {
            throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '账单已被其他支付占用');
          }
          // 保留 PaymentBill，兼容既有列表/收据的多账单读取路径。
          await tx.paymentBill.create({ data: { paymentId: p.id, billId } });
          await this.audit.append(
            {
              tenantId,
              communityId,
              actorType: 'WX_USER',
              actorId: ownerId,
              action: 'CREATE',
              resourceType: 'Payment',
              resourceId: p.id,
              requestId,
              afterSummary: { orderNo: p.orderNo, billId, totalAmount: p.totalAmount, channel },
            },
            tx,
          );
          return p;
        });
      } catch (error) {
        await this.idempotency.fail({
          tenantId,
          recordId: reservation.recordId,
          errorCode: error instanceof BizException ? String(error.code) : 'CREATE_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // 预下单放在事务外，避免网络耗时占用数据库连接。
      try {
        const payParams = await this.provider.createOrder({
          orderNo: payment.orderNo,
          totalCents,
          description: bill.title.slice(0, 100),
          payerOpenid: user?.openid ?? '',
          tenantId,
        });
        const response = { orderNo: payment.orderNo, totalAmount: payment.totalAmount, payParams };
        await this.idempotency.complete({
          tenantId,
          recordId: reservation.recordId,
          responseCode: 0,
          responseBody: response,
        });
        return response;
      } catch (error) {
        if (this.isExplicitPrepayReject(error)) {
          // 明确拒绝：立即失败并释放账单预占。
          await this.finishUnpaidPayment(payment.id, 'FAILED');
          await this.idempotency.fail({
            tenantId,
            recordId: reservation.recordId,
            errorCode: error instanceof PaymentProviderError ? error.code : 'PREPAY_REJECTED',
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        // 结果不确定：转 PREPAY_UNKNOWN，账单保持预占，交由恢复任务查单裁决。
        await this.prisma.raw.payment.updateMany({
          where: { id: payment.id, status: 'CREATED' },
          data: { status: 'PREPAY_UNKNOWN' },
        });
        const response = { orderNo: payment.orderNo, totalAmount: payment.totalAmount, status: 'PREPAY_UNKNOWN' as const };
        await this.idempotency.complete({
          tenantId,
          recordId: reservation.recordId,
          responseCode: 0,
          responseBody: response,
        });
        return response;
      }
    });
  }

  /** 成功入账时生成的不可变、与付款人无关的收据快照。 */
  private buildReceipt(
    payment: ReceiptPayment,
    paidAt: Date,
    transactionId: string | null,
  ): { receiptNo: string; snapshot: Prisma.InputJsonObject } {
    const receiptNo = `RCPT-${payment.orderNo}`;
    const bills = (payment.paymentBills ?? []).map((pb) => ({
      title: pb.bill?.title ?? null,
      period: pb.bill?.period ?? null,
      amount: pb.bill?.amount != null ? String(pb.bill.amount) : null,
    }));
    const firstHouse = payment.paymentBills?.[0]?.bill?.house ?? null;
    const snapshot: Prisma.InputJsonObject = {
      receiptNo,
      orderNo: payment.orderNo,
      channel: payment.channel,
      transactionId: transactionId ?? null,
      totalAmount: String(payment.totalAmount),
      paidAt: paidAt.toISOString(),
      community: firstHouse?.community?.name ?? null,
      house: firstHouse?.displayName ?? null,
      bills,
      issuedAt: new Date().toISOString(),
    };
    return { receiptNo, snapshot };
  }

  /**
   * 幂等成功入账 + 事务内生成不可变收据快照。
   * source 记录确认来源（回调/查单/mock），供审计与对账区分。
   */
  private async applyWxPaySuccess(
    payment: {
      id: string;
      orderNo: string;
      status: string;
      transactionId: string | null;
      channel: string;
      totalAmount: unknown;
      paymentBills: Array<{ billId: string; bill?: ReceiptBill | null }>;
    },
    transaction: WxPayTransaction,
    source: 'WXPAY_NOTIFY' | 'WXPAY_QUERY',
  ): Promise<{ orderNo: string; status: 'SUCCESS' }> {
    if (payment.status === 'SUCCESS') {
      if (payment.transactionId !== transaction.transaction_id) throw new Error('支付回调交易号不一致');
      return { orderNo: payment.orderNo, status: 'SUCCESS' };
    }
    if (!ACTIVE_PAYMENT_STATUSES.includes(payment.status as (typeof ACTIVE_PAYMENT_STATUSES)[number])) {
      throw new Error(`支付回调订单状态不可入账：${payment.status}`);
    }

    const paidAt = transaction.success_time ? new Date(transaction.success_time) : new Date();
    if (Number.isNaN(paidAt.getTime())) throw new Error('支付回调成功时间无效');
    const { receiptNo, snapshot } = this.buildReceipt(payment, paidAt, transaction.transaction_id);

    await this.prisma.raw.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: payment.id, status: { in: [...ACTIVE_PAYMENT_STATUSES] } },
        data: {
          status: 'SUCCESS',
          transactionId: transaction.transaction_id,
          paidAt,
          confirmedBy: source,
          confirmedAt: new Date(),
          receiptNo,
          receiptSnapshot: snapshot,
        },
      });
      if (updated.count === 0) return;

      const bills = await tx.bill.updateMany({
        where: {
          id: { in: payment.paymentBills.map((item) => item.billId) },
          status: 'UNPAID',
          paymentId: payment.id,
        },
        data: { status: 'PAID', paidAt },
      });
      if (bills.count !== payment.paymentBills.length) throw new Error('支付订单关联账单状态异常');
    });

    return { orderNo: payment.orderNo, status: 'SUCCESS' };
  }

  private receiptInclude() {
    return {
      paymentBills: {
        include: { bill: { include: { house: { include: { community: { select: { name: true } } } } } } },
      },
    };
  }

  /** 主动查单成功入账（查单来源）：供 sync/cancel/reconcile 复用。 */
  async handleWxPaySuccess(transaction: WxPayTransaction) {
    const payment = await this.prisma.raw.payment.findUnique({
      where: { orderNo: transaction.out_trade_no },
      include: this.receiptInclude(),
    });
    if (!payment) throw new Error('支付回调订单不存在');
    if (payment.channel !== 'WXPAY') throw new Error('支付回调订单渠道不匹配');

    const expectedCents = toCents(payment.totalAmount.toString());
    if (transaction.amount.total !== expectedCents) throw new Error('支付回调金额不一致');

    return this.applyWxPaySuccess(payment, transaction, 'WXPAY_QUERY');
  }

  /**
   * 微信支付回调：验签解密已由 Provider 完成。
   * 先持久化回调证据（PaymentEvent + wxpayNotifiedAt，即使已通过查单成功也记录），再幂等成功入账。
   */
  async handleWxPayNotification(transaction: WxPayTransaction) {
    const payment = await this.prisma.raw.payment.findUnique({
      where: { orderNo: transaction.out_trade_no },
      include: this.receiptInclude(),
    });
    if (!payment) throw new Error('支付回调订单不存在');
    if (payment.channel !== 'WXPAY') throw new Error('支付回调订单渠道不匹配');

    const expectedCents = toCents(payment.totalAmount.toString());
    if (transaction.amount.total !== expectedCents) throw new Error('支付回调金额不一致');

    await this.recordNotifyEvidence(payment, transaction);
    return this.applyWxPaySuccess(payment, transaction, 'WXPAY_NOTIFY');
  }

  /** 记录回调证据：PaymentEvent(NOTIFIED) 幂等 + 首次置 wxpayNotifiedAt。证据不含付款人身份。 */
  private async recordNotifyEvidence(
    payment: { id: string; tenantId: string; communityId: string | null; orderNo: string },
    transaction: WxPayTransaction,
  ): Promise<void> {
    const eventKey = `notify:${payment.orderNo}:${transaction.transaction_id}`;
    await this.prisma.raw.$transaction(async (tx) => {
      const existing = await tx.paymentEvent.findFirst({
        where: { tenantId: payment.tenantId, eventKey },
      });
      if (!existing) {
        await tx.paymentEvent.create({
          data: {
            tenantId: payment.tenantId,
            communityId: payment.communityId,
            paymentId: payment.id,
            eventKey,
            type: 'NOTIFIED',
            status: 'PROCESSED',
            source: 'WXPAY_NOTIFY',
            summary: {
              transactionId: transaction.transaction_id,
              tradeState: transaction.trade_state,
              amountTotal: transaction.amount.total,
              successTime: transaction.success_time ?? null,
            },
            occurredAt: transaction.success_time ? new Date(transaction.success_time) : new Date(),
            processedAt: new Date(),
          },
        });
      }
      await tx.payment.updateMany({
        where: { id: payment.id, wxpayNotifiedAt: null },
        data: { wxpayNotifiedAt: new Date() },
      });
    });
  }

  /** mock 确认支付：事务内翻转订单与账单状态；重复调用幂等 */
  async mockConfirm(ownerId: string, orderNo: string) {
    const mockAllowed = process.env.PAY_MODE === 'mock'
      && process.env.ALLOW_MOCK_PAYMENTS === 'true';
    if (!mockAllowed) {
      throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '当前环境不可 mock 确认');
    }
    const payment = await this.prisma.raw.payment.findUnique({
      where: { orderNo },
      include: this.receiptInclude(),
    });
    if (!payment || payment.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
    if (payment.channel !== 'MOCK') throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '真实支付订单不可 mock 确认');
    if (payment.status === 'SUCCESS') return { orderNo, status: 'SUCCESS' }; // 幂等
    if (payment.status !== 'CREATED') {
      throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, `订单状态 ${payment.status}`);
    }

    const paidAt = new Date();
    const transactionId = `MOCK-${orderNo}`;
    const { receiptNo, snapshot } = this.buildReceipt(payment, paidAt, transactionId);
    await this.prisma.raw.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: payment.id, status: 'CREATED' },
        data: {
          status: 'SUCCESS',
          paidAt,
          transactionId,
          confirmedBy: 'MOCK',
          confirmedAt: new Date(),
          receiptNo,
          receiptSnapshot: snapshot,
        },
      });
      if (updated.count === 0) return; // 并发下已被处理
      const bills = await tx.bill.updateMany({
        where: {
          id: { in: payment.paymentBills.map((pb) => pb.billId) },
          status: 'UNPAID',
          paymentId: payment.id,
        },
        data: { status: 'PAID', paidAt },
      });
      if (bills.count !== payment.paymentBills.length) throw new Error('Mock 支付关联账单状态异常');
    });
    return { orderNo, status: 'SUCCESS', paidAt };
  }

  private async finishUnpaidPayment(paymentId: string, status: 'CLOSED' | 'FAILED'): Promise<void> {
    await this.prisma.raw.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: paymentId, status: { in: [...ACTIVE_PAYMENT_STATUSES] } },
        data: { status },
      });
      if (updated.count === 0) return;
      await tx.bill.updateMany({
        where: { paymentId, status: 'UNPAID' },
        data: { paymentId: null },
      });
    });
  }

  /** 用户取消收银台后先查单，确认未支付才关单并释放账单。 */
  async cancelWxPay(ownerId: string, orderNo: string) {
    const payment = await this.prisma.raw.payment.findUnique({ where: { orderNo } });
    if (!payment || payment.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
    if (payment.status === 'SUCCESS') return { orderNo, status: 'SUCCESS' as const };
    if (payment.channel !== 'WXPAY' || payment.status !== 'CREATED') {
      return { orderNo, status: payment.status };
    }
    if (!this.provider.queryOrder) throw new Error('当前支付渠道不支持主动查单');

    const transaction = await this.provider.queryOrder(orderNo);
    if (transaction.trade_state === 'SUCCESS') return this.handleWxPaySuccess(transaction);
    if (transaction.trade_state === 'REFUND') throw new Error('退款状态需通过退款单核对');
    if (transaction.trade_state !== 'CLOSED') await this.provider.close(orderNo);
    await this.finishUnpaidPayment(payment.id, 'CLOSED');
    return { orderNo, status: 'CLOSED' as const };
  }

  /** 定时任务处理超过支付窗口的 CREATED / PREPAY_UNKNOWN 订单，避免账单被永久占用。 */
  async reconcileStaleWxPay(orderNo: string) {
    const payment = await this.prisma.raw.payment.findUnique({ where: { orderNo } });
    if (
      !payment ||
      payment.channel !== 'WXPAY' ||
      !ACTIVE_PAYMENT_STATUSES.includes(payment.status as (typeof ACTIVE_PAYMENT_STATUSES)[number])
    ) {
      return payment ? { orderNo, status: payment.status } : null;
    }
    if (!this.provider.queryOrder) throw new Error('当前支付渠道不支持主动查单');

    let transaction: WxPayTransaction;
    try {
      transaction = await this.provider.queryOrder(orderNo);
    } catch (error) {
      if (error instanceof PaymentProviderError && error.code === 'ORDER_NOT_EXIST') {
        await this.finishUnpaidPayment(payment.id, 'FAILED');
        return { orderNo, status: 'FAILED' as const };
      }
      throw error;
    }
    if (transaction.trade_state === 'SUCCESS') return this.handleWxPaySuccess(transaction);
    if (transaction.trade_state === 'REFUND') throw new Error('退款状态需通过退款单核对');
    if (transaction.trade_state === 'NOTPAY') {
      await this.provider.close(orderNo);
      await this.finishUnpaidPayment(payment.id, 'CLOSED');
      return { orderNo, status: 'CLOSED' as const };
    }
    if (transaction.trade_state === 'CLOSED') {
      await this.finishUnpaidPayment(payment.id, 'CLOSED');
      return { orderNo, status: 'CLOSED' as const };
    }
    if (['REVOKED', 'PAYERROR'].includes(transaction.trade_state)) {
      await this.finishUnpaidPayment(payment.id, 'FAILED');
      return { orderNo, status: 'FAILED' as const };
    }
    return { orderNo, status: payment.status };
  }

  /**
   * 管理端解决账单占用的订单（供账单作废前调用）：
   * SUCCESS 直接返回；WXPAY 进行中 → 查单裁决；MOCK/OFFLINE 进行中 → 关单释放账单。
   */
  async resolveActiveOrder(orderNo: string): Promise<{ orderNo: string; status: string } | null> {
    const payment = await this.prisma.raw.payment.findUnique({ where: { orderNo } });
    if (!payment) return null;
    if (!ACTIVE_PAYMENT_STATUSES.includes(payment.status as (typeof ACTIVE_PAYMENT_STATUSES)[number])) {
      return { orderNo, status: payment.status };
    }
    if (payment.channel === 'WXPAY') {
      const result = await this.reconcileStaleWxPay(orderNo);
      return result ?? { orderNo, status: payment.status };
    }
    await this.finishUnpaidPayment(payment.id, 'CLOSED');
    return { orderNo, status: 'CLOSED' };
  }

  /** 前端支付后主动查单，回调延迟或丢失时复用同一入账逻辑。 */
  async syncWxPay(ownerId: string, orderNo: string) {
    const payment = await this.prisma.raw.payment.findUnique({ where: { orderNo } });
    if (!payment || payment.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
    if (payment.status === 'SUCCESS') return { orderNo, status: 'SUCCESS' as const };
    if (payment.channel !== 'WXPAY') return { orderNo, status: payment.status };
    if (!this.provider.queryOrder) throw new Error('当前支付渠道不支持主动查单');

    const transaction = await this.provider.queryOrder(orderNo);
    if (transaction.out_trade_no !== orderNo) throw new Error('微信支付查单订单号不匹配');
    if (transaction.trade_state === 'SUCCESS') {
      if (!transaction.transaction_id) throw new Error('微信支付查单缺少交易号');
      return this.handleWxPaySuccess(transaction);
    }

    if (transaction.trade_state === 'CLOSED') {
      await this.finishUnpaidPayment(payment.id, 'CLOSED');
      return { orderNo, status: 'CLOSED' as const };
    }
    if (transaction.trade_state === 'REFUND') throw new Error('退款状态需通过退款单核对');
    if (['REVOKED', 'PAYERROR'].includes(transaction.trade_state)) {
      await this.finishUnpaidPayment(payment.id, 'FAILED');
      return { orderNo, status: 'FAILED' as const };
    }
    return { orderNo, status: payment.status };
  }

  /**
   * 确认页向后端复核：返回该账单的权威金额与分层收款状态，
   * 前端据此展示，不再信任本地缓存的选中汇总。
   */
  async quoteBill(ownerId: string, billId: string) {
    if (typeof billId !== 'string' || !billId) throw new BizException(ErrorCode.VALIDATION, '缺少账单');
    const bill = await this.prisma.raw.bill.findUnique({
      where: { id: billId },
      include: { house: { include: { community: { select: { name: true } } } } },
    });
    if (!bill) throw new BizException(ErrorCode.NOT_FOUND);
    const binding = await this.prisma.raw.houseBinding.findFirst({
      where: { wxUserId: ownerId, houseId: bill.houseId, status: 'ACTIVE' },
    });
    if (!binding) throw new BizException(ErrorCode.NO_BINDING);
    const collection = await this.collectionPolicy.resolveEffectiveStatus(bill.tenantId, bill.communityId);
    // 占用校验：被进行中订单（CREATED/PREPAY_UNKNOWN）占用的账单，虽仍 UNPAID 但此刻不可再发起支付，
    // 否则确认页显示"可付"、点击却被 createPayment 以"存在进行中的支付"拒绝。
    const occupied = await this.prisma.raw.paymentBill.findFirst({
      where: { billId: bill.id, payment: { status: { in: [...ACTIVE_PAYMENT_STATUSES] } } },
      select: { billId: true },
    });
    return {
      billId: bill.id,
      title: bill.title,
      amount: bill.amount,
      status: bill.status,
      period: bill.period,
      house: { displayName: bill.house.displayName, communityName: bill.house.community.name },
      collection,
      pendingOrder: !!occupied,
      payable: bill.status === 'UNPAID' && collection.status === 'OPEN' && !occupied,
    };
  }

  async listPayments(ownerId: string, page: number, pageSize: number) {
    const where = { wxUserId: ownerId };
    const [list, total] = await Promise.all([
      this.prisma.raw.payment.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { paymentBills: { include: { bill: { select: { title: true, amount: true, period: true } } } } },
      }),
      this.prisma.raw.payment.count({ where }),
    ]);
    return {
      list: list.map((p) => ({
        orderNo: p.orderNo,
        totalAmount: p.totalAmount,
        status: p.status,
        channel: p.channel,
        paidAt: p.paidAt,
        createdAt: p.createdAt,
        bills: p.paymentBills.map((pb) => pb.bill),
      })),
      total,
      page,
      pageSize,
    };
  }

  async getPayment(ownerId: string, orderNo: string) {
    const p = await this.prisma.raw.payment.findUnique({
      where: { orderNo },
      include: {
        paymentBills: {
          include: {
            bill: { include: { house: { include: { community: { select: { name: true } } } } } },
          },
        },
      },
    });
    if (!p || p.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
    // 收据房屋以「订单本身对应的房屋」为准（取首张账单的房屋），而非当前选中房屋
    const firstHouse = p.paymentBills[0]?.bill?.house ?? null;
    // 收据：优先不可变快照；发布前已支付的历史订单无快照 → 按订单当前数据回退生成，保证老收据不消失
    let receiptNo = p.receiptNo ?? null;
    let receipt: unknown = p.receiptSnapshot ?? null;
    if (!receipt && (p.status === 'SUCCESS' || p.status === 'REFUNDED')) {
      const fb = this.buildReceipt(p, p.paidAt ?? p.createdAt, null);
      receiptNo = fb.receiptNo;
      receipt = fb.snapshot;
    }
    return {
      orderNo: p.orderNo,
      totalAmount: p.totalAmount,
      status: p.status,
      channel: p.channel,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
      house: firstHouse
        ? { displayName: firstHouse.displayName, communityName: firstHouse.community.name }
        : null,
      bills: p.paymentBills.map((pb) => {
        const { house: _h, ...bill } = pb.bill as Record<string, unknown>;
        return bill;
      }),
      // 收据：不可变快照优先，历史订单回退生成；退款订单标记作废
      receiptNo,
      receipt,
      receiptVoid: p.status === 'REFUNDED',
    };
  }
}
