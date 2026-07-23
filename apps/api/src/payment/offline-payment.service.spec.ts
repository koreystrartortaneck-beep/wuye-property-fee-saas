import { OfflinePaymentService } from './offline-payment.service';

describe('OfflinePaymentService 线下核销与冲正', () => {
  let idempotency: { reserve: jest.Mock; complete: jest.Mock; fail: jest.Mock };
  let audit: { append: jest.Mock };
  let orderCloser: { resolveActiveOrder: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    idempotency = {
      reserve: jest.fn().mockResolvedValue({ outcome: 'RESERVED', recordId: 'idem-1' }),
      complete: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    };
    audit = { append: jest.fn().mockResolvedValue(undefined) };
    orderCloser = { resolveActiveOrder: jest.fn().mockResolvedValue({ orderNo: 'WY1', status: 'CLOSED' }) };
  });

  const bill = {
    id: 'bill-1', tenantId: 'tenant-1', communityId: 'community-1', houseId: 'house-1',
    title: '物业费', period: '2026-07', amount: { toString: () => '100.00' }, status: 'UNPAID', paymentId: null,
    house: { displayName: '101', community: { name: '小区' } },
  };

  function makeTx() {
    return {
      payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      paymentBill: { create: jest.fn().mockResolvedValue({}) },
      refund: { create: jest.fn().mockResolvedValue({ id: 'refund-1' }) },
    };
  }

  function makePrisma(tx: ReturnType<typeof makeTx>, overrides: Record<string, unknown> = {}) {
    return {
      raw: {
        bill: { findUnique: jest.fn().mockResolvedValue(bill) },
        payment: { findUnique: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(async (cb: (client: typeof tx) => unknown) => cb(tx)),
      },
      ...overrides,
    };
  }

  const makeService = (prisma: unknown) =>
    new OfflinePaymentService(prisma as never, idempotency as never, audit as never, orderCloser as never);

  const settleInput = {
    billId: 'bill-1', adminId: 'admin-1', actingTenantId: 'tenant-1',
    voucherNo: 'V-001', paidAt: '2026-07-10T00:00:00.000Z', payerName: '张三', requestId: 'req-1',
  };

  it('核销成功：建 SUCCESS/OFFLINE 支付+收据+账单 PAID，事务内写审计', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const service = makeService(prisma);
    const res = await service.settleOffline(settleInput);
    expect(res.status).toBe('SUCCESS');
    expect(res.orderNo).toMatch(/^OFF/);
    expect(tx.payment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ channel: 'OFFLINE', status: 'SUCCESS', offlineVoucherNo: 'V-001', confirmedBy: 'OFFLINE' }),
    }));
    expect(tx.bill.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'bill-1', status: 'UNPAID', paymentId: null }),
      data: expect.objectContaining({ status: 'PAID' }),
    }));
    expect(tx.paymentBill.create).toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAY' }), tx);
  });

  it('缺凭证号或缴费时间被拒', async () => {
    const service = makeService(makePrisma(makeTx()));
    await expect(service.settleOffline({ ...settleInput, voucherNo: '' })).rejects.toMatchObject({ code: 40000 });
    await expect(service.settleOffline({ ...settleInput, paidAt: 'not-a-date' })).rejects.toMatchObject({ code: 40000 });
  });

  it('非未缴账单不可核销', async () => {
    const prisma = makePrisma(makeTx());
    prisma.raw.bill.findUnique.mockResolvedValue({ ...bill, status: 'PAID' });
    const service = makeService(prisma);
    await expect(service.settleOffline(settleInput)).rejects.toMatchObject({ code: 43001 });
  });

  it('存在进行中线上订单：先查关，成功回调则拒绝核销', async () => {
    const prisma = makePrisma(makeTx());
    prisma.raw.bill.findUnique
      .mockResolvedValueOnce({ ...bill, paymentId: 'wxpay-1' })
      .mockResolvedValueOnce({ ...bill, status: 'PAID', paymentId: 'wxpay-1' });
    prisma.raw.payment.findUnique.mockResolvedValue({ id: 'wxpay-1', orderNo: 'WY1' });
    orderCloser.resolveActiveOrder.mockResolvedValue({ orderNo: 'WY1', status: 'SUCCESS' });
    const service = makeService(prisma);
    await expect(service.settleOffline(settleInput)).rejects.toMatchObject({ code: 43002 });
    expect(orderCloser.resolveActiveOrder).toHaveBeenCalledWith('WY1');
  });

  it('凭证号重复（P2002）被拒', async () => {
    const tx = makeTx();
    tx.payment.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    const prisma = makePrisma(tx);
    const service = makeService(prisma);
    await expect(service.settleOffline(settleInput)).rejects.toMatchObject({ code: 40000 });
    expect(idempotency.fail).toHaveBeenCalled();
  });

  it('相同 requestId 重放返回已存结果', async () => {
    idempotency.reserve.mockResolvedValue({ outcome: 'REPLAY', recordId: 'idem-1', responseBody: { orderNo: 'OFF1', receiptNo: 'RCPT-OFF1', status: 'SUCCESS' } });
    const service = makeService(makePrisma(makeTx()));
    const res = await service.settleOffline(settleInput);
    expect(res.orderNo).toBe('OFF1');
  });

  it('冲正：复用退款聚合（OFFLINE）直接成功，不外呼微信', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    prisma.raw.payment.findUnique.mockResolvedValue({ id: 'payment-1', tenantId: 'tenant-1', communityId: 'community-1', orderNo: 'OFF1', channel: 'OFFLINE', status: 'SUCCESS', totalAmount: { toString: () => '100.00' }, billId: 'bill-1' });
    const service = makeService(prisma);
    const res = await service.reverseOffline({ orderNo: 'OFF1', adminId: 'admin-1', actingTenantId: 'tenant-1', reason: '误收', requestId: 'req-2' });
    expect(res.status).toBe('SUCCESS');
    expect(tx.refund.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ channel: 'OFFLINE', status: 'SUCCESS', type: 'FULL', refundAmount: '100.00', originalAmount: '100.00' }),
    }));
    expect(tx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'REFUNDED' } }));
    expect(tx.bill.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'REFUNDED' } }));
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'REFUND' }), tx);
  });

  it('非线下订单不可线下冲正', async () => {
    const prisma = makePrisma(makeTx());
    prisma.raw.payment.findUnique.mockResolvedValue({ id: 'p', tenantId: 'tenant-1', communityId: 'c', orderNo: 'WY1', channel: 'WXPAY', status: 'SUCCESS', totalAmount: { toString: () => '1.00' } });
    const service = makeService(prisma);
    await expect(service.reverseOffline({ orderNo: 'WY1', adminId: 'admin-1', actingTenantId: 'tenant-1', reason: 'x', requestId: 'req-3' })).rejects.toMatchObject({ code: 43005 });
  });
});
