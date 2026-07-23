import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { toCents } from '../billing/engine/money';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';
import { CollectionPolicyService } from './collection-policy.service';
import { PAYMENT_PROVIDER, PaymentProvider, PaymentProviderError, WxPayTransaction } from './provider';

/**
 * 支付服务（业主端，跨租户经绑定校验 → raw client）。
 * 状态机：CREATED → SUCCESS（mock-confirm/回调）；重复确认幂等。
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly collectionPolicy: CollectionPolicyService,
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

  /** 合并下单：billIds 必须同租户、全部属于本人 ACTIVE 绑定房屋、全部 UNPAID、未被进行中订单占用 */
  async createPayment(ownerId: string, billIds: string[]) {
    if (billIds.length === 0) throw new BizException(ErrorCode.VALIDATION, '请选择账单');

    const bills = await this.prisma.raw.bill.findMany({ where: { id: { in: billIds } } });
    if (bills.length !== billIds.length) throw new BizException(ErrorCode.NOT_FOUND, '存在无效账单');

    const tenantIds = new Set(bills.map((b) => b.tenantId));
    if (tenantIds.size > 1) throw new BizException(ErrorCode.VALIDATION, '不能跨物业公司合并支付');

    // 归属校验：账单房屋必须有本人 ACTIVE 绑定
    const houseIds = [...new Set(bills.map((b) => b.houseId))];
    const bindings = await this.prisma.raw.houseBinding.findMany({
      where: { wxUserId: ownerId, houseId: { in: houseIds }, status: 'ACTIVE' },
    });
    if (bindings.length !== houseIds.length) throw new BizException(ErrorCode.NO_BINDING);

    for (const bill of bills) {
      if (bill.status !== 'UNPAID') {
        throw new BizException(ErrorCode.BILL_NOT_PAYABLE, `账单「${bill.title}」状态为 ${bill.status}`);
      }
    }

    // 占用校验：账单不在其他 CREATED 订单里
    const occupied = await this.prisma.raw.paymentBill.findFirst({
      where: { billId: { in: billIds }, payment: { status: 'CREATED' } },
    });
    if (occupied) throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '存在进行中的支付，请先完成或等待其关闭');

    const totalCents = bills.reduce((s, b) => s + toCents(b.amount.toString()), 0);
    const user = await this.prisma.raw.wxUser.findUnique({ where: { id: ownerId } });
    const tenantId = bills[0].tenantId;
    const communityIds = [...new Set(bills.map((b) => b.communityId))];
    const channel = this.resolveChannel();
    if (channel === 'WXPAY') this.assertWxPayScope(tenantId, communityIds);

    const payment = await this.prisma.raw.$transaction(async (tx) => {
      // 与账单预占同事务加锁复核分层收款策略，防止并发暂停被绕过。
      await this.collectionPolicy.assertOpenForUpdate(tx, tenantId, communityIds);
      const p = await tx.payment.create({
        data: {
          tenantId,
          wxUserId: ownerId,
          orderNo: this.genOrderNo(),
          totalAmount: (totalCents / 100).toFixed(2),
          channel,
          status: 'CREATED',
        },
      });
      const reserved = await tx.bill.updateMany({
        where: { id: { in: billIds }, status: 'UNPAID', paymentId: null },
        data: { paymentId: p.id },
      });
      if (reserved.count !== billIds.length) {
        throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '账单已被其他支付占用');
      }
      await tx.paymentBill.createMany({ data: billIds.map((billId) => ({ paymentId: p.id, billId })) });
      return p;
    });

    try {
      const payParams = await this.provider.createOrder({
        orderNo: payment.orderNo,
        totalCents,
        description: bills.map((b) => b.title).join('、').slice(0, 100),
        payerOpenid: user?.openid ?? '',
        tenantId,
      });
      return { orderNo: payment.orderNo, totalAmount: payment.totalAmount, payParams };
    } catch (error) {
      await this.prisma.raw.$transaction(async (tx) => {
        await tx.payment.updateMany({
          where: { id: payment.id, status: 'CREATED' },
          data: { status: 'FAILED' },
        });
        await tx.bill.updateMany({
          where: { paymentId: payment.id, status: 'UNPAID' },
          data: { paymentId: null },
        });
      });
      throw error;
    }
  }

  /** 微信支付成功回调：验签解密已由 Provider 完成，此处核对业务订单并幂等入账。 */
  async handleWxPaySuccess(transaction: WxPayTransaction) {
    const payment = await this.prisma.raw.payment.findUnique({
      where: { orderNo: transaction.out_trade_no },
      include: { paymentBills: true },
    });
    if (!payment) throw new Error('支付回调订单不存在');
    if (payment.channel !== 'WXPAY') throw new Error('支付回调订单渠道不匹配');

    const expectedCents = toCents(payment.totalAmount.toString());
    if (transaction.amount.total !== expectedCents) throw new Error('支付回调金额不一致');

    if (payment.status === 'SUCCESS') {
      if (payment.transactionId !== transaction.transaction_id) throw new Error('支付回调交易号不一致');
      return { orderNo: payment.orderNo, status: 'SUCCESS' as const };
    }
    if (payment.status !== 'CREATED') throw new Error(`支付回调订单状态不可入账：${payment.status}`);

    const paidAt = transaction.success_time ? new Date(transaction.success_time) : new Date();
    if (Number.isNaN(paidAt.getTime())) throw new Error('支付回调成功时间无效');

    await this.prisma.raw.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: payment.id, status: 'CREATED' },
        data: {
          status: 'SUCCESS',
          transactionId: transaction.transaction_id,
          paidAt,
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

    return { orderNo: payment.orderNo, status: 'SUCCESS' as const };
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
      include: { paymentBills: true },
    });
    if (!payment || payment.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
    if (payment.channel !== 'MOCK') throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '真实支付订单不可 mock 确认');
    if (payment.status === 'SUCCESS') return { orderNo, status: 'SUCCESS' }; // 幂等
    if (payment.status !== 'CREATED') {
      throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, `订单状态 ${payment.status}`);
    }

    const paidAt = new Date();
    await this.prisma.raw.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: payment.id, status: 'CREATED' },
        data: { status: 'SUCCESS', paidAt, transactionId: `MOCK-${orderNo}` },
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
        where: { id: paymentId, status: 'CREATED' },
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

  /** 定时任务处理超过支付窗口的订单，避免账单被永久占用。 */
  async reconcileStaleWxPay(orderNo: string) {
    const payment = await this.prisma.raw.payment.findUnique({ where: { orderNo } });
    if (!payment || payment.channel !== 'WXPAY' || payment.status !== 'CREATED') {
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
    return { orderNo, status: 'CREATED' as const };
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
    return { orderNo, status: 'CREATED' as const };
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
    };
  }
}
