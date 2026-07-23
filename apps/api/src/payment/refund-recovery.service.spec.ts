import { RefundRecoveryService } from './refund-recovery.service';

describe('RefundRecoveryService', () => {
  const originalMode = process.env.PAY_MODE;
  afterEach(() => { process.env.PAY_MODE = originalMode; });

  it('扫描 CREATED/PROCESSING 退款并以租约认领后逐笔查单，单笔失败不阻断', async () => {
    process.env.PAY_MODE = 'wxpay';
    const prisma = {
      raw: {
        refund: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'r1', refundNo: 'RF-1', lastQueriedAt: null },
            { id: 'r2', refundNo: 'RF-2', lastQueriedAt: new Date('2026-07-22T09:00:00Z') },
          ]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      },
    };
    const refunds = {
      recoverRefund: jest.fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce({ status: 'SUCCESS' }),
    };
    const service = new RefundRecoveryService(prisma as never, refunds as never);

    await service.recoverStaleRefunds(new Date('2026-07-22T10:00:00Z'));

    expect(prisma.raw.refund.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ channel: 'WXPAY', status: { in: ['CREATED', 'PROCESSING'] } }),
    }));
    expect(prisma.raw.refund.updateMany).toHaveBeenCalledTimes(2);
    expect(refunds.recoverRefund).toHaveBeenCalledTimes(2);
  });

  it('认领失败（被其他实例抢占）时跳过', async () => {
    process.env.PAY_MODE = 'wxpay';
    const prisma = {
      raw: {
        refund: {
          findMany: jest.fn().mockResolvedValue([{ id: 'r1', refundNo: 'RF-1', lastQueriedAt: null }]),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      },
    };
    const refunds = { recoverRefund: jest.fn() };
    const service = new RefundRecoveryService(prisma as never, refunds as never);

    await service.recoverStaleRefunds(new Date('2026-07-22T10:00:00Z'));
    expect(refunds.recoverRefund).not.toHaveBeenCalled();
  });
});
