import { PaymentReconciliationService } from './payment-reconciliation.service';

describe('PaymentReconciliationService', () => {
  const originalMode = process.env.PAY_MODE;

  afterEach(() => {
    process.env.PAY_MODE = originalMode;
  });

  it('逐笔处理超过 30 分钟的微信支付订单且单笔失败不阻断后续', async () => {
    process.env.PAY_MODE = 'wxpay';
    const prisma = {
      raw: {
        payment: {
          findMany: jest.fn().mockResolvedValue([{ orderNo: 'WY1' }, { orderNo: 'WY2' }]),
        },
      },
    };
    const payments = {
      reconcileStaleWxPay: jest.fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce({ status: 'CLOSED' }),
    };
    const service = new PaymentReconciliationService(prisma as never, payments as never);

    await service.closeStaleOrders(new Date('2026-07-22T10:00:00Z'));

    expect(prisma.raw.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ channel: 'WXPAY', status: 'CREATED' }),
      take: 100,
    }));
    expect(payments.reconcileStaleWxPay).toHaveBeenCalledTimes(2);
  });
});
