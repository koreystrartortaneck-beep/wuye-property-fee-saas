import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { toCents } from '../billing/engine/money';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_PROVIDER, PaymentProvider } from './provider';

/**
 * 支付服务（业主端，跨租户经绑定校验 → raw client）。
 * 状态机：CREATED → SUCCESS（mock-confirm/回调）；重复确认幂等。
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

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

    const payment = await this.prisma.raw.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          tenantId,
          wxUserId: ownerId,
          orderNo: this.genOrderNo(),
          totalAmount: (totalCents / 100).toFixed(2),
          channel: process.env.PAY_MODE === 'wxpay' ? 'WXPAY' : 'MOCK',
          status: 'CREATED',
        },
      });
      await tx.paymentBill.createMany({ data: billIds.map((billId) => ({ paymentId: p.id, billId })) });
      return p;
    });

    const payParams = await this.provider.createOrder({
      orderNo: payment.orderNo,
      totalCents,
      description: bills.map((b) => b.title).join('、').slice(0, 100),
      payerOpenid: user?.openid ?? '',
      tenantId,
    });

    return { orderNo: payment.orderNo, totalAmount: payment.totalAmount, payParams };
  }

  /** mock 确认支付：事务内翻转订单与账单状态；重复调用幂等 */
  async mockConfirm(ownerId: string, orderNo: string) {
    if (process.env.PAY_MODE === 'wxpay') {
      throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '真实支付模式下不可 mock 确认');
    }
    const payment = await this.prisma.raw.payment.findUnique({
      where: { orderNo },
      include: { paymentBills: true },
    });
    if (!payment || payment.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
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
      await tx.bill.updateMany({
        where: { id: { in: payment.paymentBills.map((pb) => pb.billId) }, status: 'UNPAID' },
        data: { status: 'PAID', paidAt, paymentId: payment.id },
      });
    });
    return { orderNo, status: 'SUCCESS', paidAt };
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
      include: { paymentBills: { include: { bill: true } } },
    });
    if (!p || p.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
    return {
      orderNo: p.orderNo,
      totalAmount: p.totalAmount,
      status: p.status,
      channel: p.channel,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
      bills: p.paymentBills.map((pb) => pb.bill),
    };
  }
}
