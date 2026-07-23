import { PaymentRecoveryService } from './payment-recovery.service';

describe('PaymentRecoveryService', () => {
  const originalMode = process.env.PAY_MODE;

  afterEach(() => {
    process.env.PAY_MODE = originalMode;
  });

  it('扫描超时的 CREATED 与 PREPAY_UNKNOWN 订单，逐笔以租约认领后处理且单笔失败不阻断', async () => {
    process.env.PAY_MODE = 'wxpay';
    const prisma = {
      raw: {
        payment: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'p1', orderNo: 'WY1', lastSyncedAt: null },
            { id: 'p2', orderNo: 'WY2', lastSyncedAt: new Date('2026-07-22T09:00:00Z') },
          ]),
          // 两笔都成功认领
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      },
    };
    const payments = {
      reconcileStaleWxPay: jest.fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce({ status: 'CLOSED' }),
    };
    const service = new PaymentRecoveryService(prisma as never, payments as never);

    await service.closeStaleOrders(new Date('2026-07-22T10:00:00Z'));

    expect(prisma.raw.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        channel: 'WXPAY',
        status: { in: ['CREATED', 'PREPAY_UNKNOWN'] },
      }),
    }));
    // 多实例租约：认领时对每笔做乐观锁 updateMany
    expect(prisma.raw.payment.updateMany).toHaveBeenCalledTimes(2);
    expect(payments.reconcileStaleWxPay).toHaveBeenCalledTimes(2);
  });

  it('认领失败（已被其他实例抢占）时跳过该订单', async () => {
    process.env.PAY_MODE = 'wxpay';
    const prisma = {
      raw: {
        payment: {
          findMany: jest.fn().mockResolvedValue([{ id: 'p1', orderNo: 'WY1', lastSyncedAt: null }]),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      },
    };
    const payments = { reconcileStaleWxPay: jest.fn() };
    const service = new PaymentRecoveryService(prisma as never, payments as never);

    await service.closeStaleOrders(new Date('2026-07-22T10:00:00Z'));

    expect(payments.reconcileStaleWxPay).not.toHaveBeenCalled();
  });
});
