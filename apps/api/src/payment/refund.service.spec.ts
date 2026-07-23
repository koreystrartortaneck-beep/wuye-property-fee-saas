import { RefundService } from './refund.service';
import { PaymentProviderError, type PaymentProvider, type WxPayRefund } from './provider';

describe('RefundService 微信全额退款闭环', () => {
  let provider: { createRefund: jest.Mock; queryRefund: jest.Mock; createOrder: jest.Mock; close: jest.Mock };
  let idempotency: { reserve: jest.Mock; complete: jest.Mock; fail: jest.Mock };
  let audit: { append: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    provider = { createRefund: jest.fn(), queryRefund: jest.fn(), createOrder: jest.fn(), close: jest.fn() };
    idempotency = {
      reserve: jest.fn().mockResolvedValue({ outcome: 'RESERVED', recordId: 'idem-1' }),
      complete: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    };
    audit = { append: jest.fn().mockResolvedValue(undefined) };
  });

  const payment = {
    id: 'payment-1', tenantId: 'tenant-1', communityId: 'community-1', billId: 'bill-1',
    orderNo: 'WY202607220001', status: 'SUCCESS', channel: 'WXPAY', transactionId: '4200000000001',
    totalAmount: { toString: () => '1.00' }, mchid: '1900000109', appid: 'wx-appid', merchantAccountId: 'SERIAL',
    paymentBills: [{ billId: 'bill-1', bill: { communityId: 'community-1' } }],
  };

  const refundRow = {
    id: 'refund-1', tenantId: 'tenant-1', communityId: 'community-1', paymentId: 'payment-1',
    paymentOrderNo: 'WY202607220001', refundNo: 'RF-WY202607220001', status: 'CREATED',
    originalAmount: { toString: () => '1.00' }, refundAmount: { toString: () => '1.00' },
    reason: '业主申请', channel: 'WXPAY', providerRefundId: null,
  };

  function makeTx() {
    return {
      refund: { create: jest.fn().mockResolvedValue(refundRow), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      paymentEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
    };
  }

  function makePrisma(tx: ReturnType<typeof makeTx>, overrides: Record<string, unknown> = {}) {
    return {
      raw: {
        payment: { findUnique: jest.fn().mockResolvedValue(payment), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        refund: {
          findUnique: jest.fn().mockResolvedValue(null),
          findFirst: jest.fn().mockResolvedValue(null),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        refundAttempt: {
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn().mockResolvedValue({ id: 'attempt-1' }),
          update: jest.fn().mockResolvedValue({}),
        },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        $transaction: jest.fn(async (cb: (client: typeof tx) => unknown) => cb(tx)),
      },
      ...overrides,
    };
  }

  function makeService(prisma: unknown): RefundService {
    return new RefundService(prisma as never, provider as unknown as PaymentProvider, idempotency as never, audit as never);
  }

  const refundResult = (over: Partial<WxPayRefund> = {}): WxPayRefund => ({
    refund_id: '50000000001', out_refund_no: 'RF-WY202607220001', out_trade_no: 'WY202607220001',
    transaction_id: '4200000000001', status: 'SUCCESS', amount: { total: 100, refund: 100 }, ...over,
  });

  it('全额退款成功：金额取自订单、锁定 REFUNDED、事务内写审计', async () => {
    provider.createRefund.mockResolvedValue(refundResult());
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const service = makeService(prisma);

    await expect(
      service.createRefund({ orderNo: 'WY202607220001', adminId: 'admin-1', actingTenantId: 'tenant-1', reason: '业主申请', requestId: 'req-1' }),
    ).resolves.toEqual({ refundNo: 'RF-WY202607220001', status: 'SUCCESS' });

    // 金额取自订单（100 分），不接受客户端金额
    expect(provider.createRefund).toHaveBeenCalledWith(expect.objectContaining({
      outRefundNo: 'RF-WY202607220001', totalCents: 100, refundCents: 100,
    }));
    // 成功锁定：Payment REFUNDED、账单 REFUNDED
    expect(tx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'payment-1', status: 'SUCCESS' }, data: { status: 'REFUNDED' },
    }));
    expect(tx.bill.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'REFUNDED' },
    }));
    // 事务内审计（创建 + 成功）
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'REFUND' }), tx);
    expect(idempotency.complete).toHaveBeenCalled();
  });

  it('相同 requestId 重放直接返回已存结果，不重复退款', async () => {
    idempotency.reserve.mockResolvedValue({ outcome: 'REPLAY', recordId: 'idem-1', responseBody: { refundNo: 'RF-WY202607220001', status: 'SUCCESS' } });
    const prisma = makePrisma(makeTx());
    const service = makeService(prisma);

    await expect(
      service.createRefund({ orderNo: 'WY202607220001', adminId: 'admin-1', actingTenantId: 'tenant-1', reason: 'x', requestId: 'req-1' }),
    ).resolves.toEqual({ refundNo: 'RF-WY202607220001', status: 'SUCCESS' });
    expect(provider.createRefund).not.toHaveBeenCalled();
  });

  it('微信明确拒绝时退款置失败并恢复账单 PAID', async () => {
    provider.createRefund.mockRejectedValue(new PaymentProviderError(400, 'NOTENOUGH', '余额不足'));
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const service = makeService(prisma);

    await expect(
      service.createRefund({ orderNo: 'WY202607220001', adminId: 'admin-1', actingTenantId: 'tenant-1', reason: 'x', requestId: 'req-2' }),
    ).rejects.toMatchObject({ code: 43005 });
    // 恢复账单 PAID（从 REFUNDING）
    expect(tx.bill.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { paymentId: 'payment-1', status: 'REFUNDING' }, data: { status: 'PAID' },
    }));
    // Refund 置 FAILED
    expect(tx.refund.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'FAILED' }),
    }));
    expect(idempotency.fail).toHaveBeenCalled();
  });

  it('网络不确定时保持 PROCESSING，账单不恢复，交由恢复查单', async () => {
    provider.createRefund.mockRejectedValue(new Error('network timeout'));
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const service = makeService(prisma);

    await expect(
      service.createRefund({ orderNo: 'WY202607220001', adminId: 'admin-1', actingTenantId: 'tenant-1', reason: 'x', requestId: 'req-3' }),
    ).resolves.toEqual({ refundNo: 'RF-WY202607220001', status: 'PROCESSING' });
    // attempt 标记 UNKNOWN
    expect(prisma.raw.refundAttempt.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'UNKNOWN' }),
    }));
    // 未把账单恢复为 PAID
    const restored = tx.bill.updateMany.mock.calls.find(([a]: [{ data: Record<string, unknown> }]) => a.data.status === 'PAID');
    expect(restored).toBeUndefined();
    expect(idempotency.complete).toHaveBeenCalled();
  });

  it('中断恢复使用稳定退款单号复用已存聚合，不重复建单', async () => {
    provider.createRefund.mockResolvedValue(refundResult({ status: 'PROCESSING' }));
    const tx = makeTx();
    const prisma = makePrisma(tx);
    // 已存在处理中的退款聚合
    prisma.raw.refund.findUnique.mockResolvedValue({ ...refundRow, status: 'PROCESSING' });
    const service = makeService(prisma);

    await service.createRefund({ orderNo: 'WY202607220001', adminId: 'admin-1', actingTenantId: 'tenant-1', reason: 'x', requestId: 'req-4' });
    expect(tx.refund.create).not.toHaveBeenCalled();
    expect(provider.createRefund).toHaveBeenCalledWith(expect.objectContaining({ outRefundNo: 'RF-WY202607220001' }));
  });

  it('跨租户订单拒绝退款', async () => {
    const prisma = makePrisma(makeTx());
    const service = makeService(prisma);
    await expect(
      service.createRefund({ orderNo: 'WY202607220001', adminId: 'admin-1', actingTenantId: 'tenant-OTHER', reason: 'x', requestId: 'req-5' }),
    ).rejects.toMatchObject({ code: 40300 });
  });

  it('非成功订单不可退款', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    prisma.raw.payment.findUnique.mockResolvedValue({ ...payment, status: 'CREATED' });
    const service = makeService(prisma);
    await expect(
      service.createRefund({ orderNo: 'WY202607220001', adminId: 'admin-1', actingTenantId: 'tenant-1', reason: 'x', requestId: 'req-6' }),
    ).rejects.toMatchObject({ code: 43005 });
  });

  it('退款回调成功：核对金额、记录证据并幂等锁定 REFUNDED', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    prisma.raw.refund.findUnique.mockResolvedValue({ ...refundRow, status: 'PROCESSING' });
    const service = makeService(prisma);

    await expect(service.handleRefundNotification(refundResult())).resolves.toEqual({
      refundNo: 'RF-WY202607220001', status: 'SUCCESS',
    });
    // 回调证据
    expect(tx.paymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'REFUNDED', refundId: 'refund-1' }),
    }));
    expect(tx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'REFUNDED' } }));
  });

  it('退款回调金额不一致时拒绝', async () => {
    const prisma = makePrisma(makeTx());
    prisma.raw.refund.findUnique.mockResolvedValue({ ...refundRow, status: 'PROCESSING' });
    const service = makeService(prisma);
    await expect(
      service.handleRefundNotification(refundResult({ amount: { total: 100, refund: 50 } })),
    ).rejects.toThrow('退款回调金额不一致');
  });

  it('恢复查单发现成功时锁定 REFUNDED', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    prisma.raw.refund.findUnique.mockResolvedValue({ ...refundRow, status: 'PROCESSING' });
    provider.queryRefund.mockResolvedValue(refundResult());
    const service = makeService(prisma);

    await expect(service.recoverRefund('RF-WY202607220001')).resolves.toEqual({
      refundNo: 'RF-WY202607220001', status: 'SUCCESS',
    });
    expect(provider.queryRefund).toHaveBeenCalledWith('RF-WY202607220001');
    expect(tx.refund.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCESS' }) }));
  });
});
