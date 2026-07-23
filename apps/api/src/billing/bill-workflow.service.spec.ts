import { BillWorkflowService } from './bill-workflow.service';

describe('BillWorkflowService 草稿发布 / 作废 / 重开', () => {
  let audit: { append: jest.Mock };
  let outbox: { enqueue: jest.Mock };
  let idempotency: { reserve: jest.Mock; complete: jest.Mock; fail: jest.Mock };
  let notifier: { onBillCreated: jest.Mock; onReminder: jest.Mock };
  let orderCloser: { resolveActiveOrder: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    audit = { append: jest.fn().mockResolvedValue(undefined) };
    outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    idempotency = {
      reserve: jest.fn().mockResolvedValue({ outcome: 'RESERVED', recordId: 'idem-1' }),
      complete: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    };
    notifier = { onBillCreated: jest.fn().mockResolvedValue(undefined), onReminder: jest.fn() };
    orderCloser = { resolveActiveOrder: jest.fn().mockResolvedValue({ orderNo: 'WY1', status: 'CLOSED' }) };
  });

  const draftBatch = {
    id: 'batch-1', tenantId: 'tenant-1', communityId: 'community-1', status: 'DRAFT',
    period: '2026-07', source: 'IMPORT', batchNo: 'B-1',
  };

  const draftBill = {
    id: 'bill-1', tenantId: 'tenant-1', communityId: 'community-1', houseId: 'house-1',
    ruleId: null, batchId: 'batch-1', source: 'IMPORT', period: '2026-07',
    title: '物业费', amount: { toString: () => '100.00' }, status: 'DRAFT', paymentId: null,
    snapshot: {}, dueDate: new Date('2026-07-31T00:00:00.000Z'),
  };

  function makeTx() {
    return {
      billBatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      bill: {
        findMany: jest.fn().mockResolvedValue([draftBill]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'bill-new', status: 'UNPAID' }),
      },
    };
  }

  function makePrisma(tx: ReturnType<typeof makeTx>, overrides: Record<string, unknown> = {}) {
    return {
      raw: {
        billBatch: { findUnique: jest.fn().mockResolvedValue(draftBatch) },
        bill: {
          findUnique: jest.fn().mockResolvedValue(draftBill),
          findMany: jest.fn().mockResolvedValue([draftBill]),
          count: jest.fn().mockResolvedValue(1),
        },
        payment: { findUnique: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(async (cb: (client: typeof tx) => unknown) => cb(tx)),
      },
      ...overrides,
    };
  }

  function makeService(prisma: unknown): BillWorkflowService {
    return new BillWorkflowService(
      prisma as never,
      audit as never,
      outbox as never,
      idempotency as never,
      notifier as never,
      orderCloser as never,
    );
  }

  const publishInput = { batchId: 'batch-1', adminId: 'admin-1', actingTenantId: 'tenant-1', requestId: 'req-1' };

  it('发布草稿批次：原子将草稿账单转 UNPAID，事务内写审计与 Outbox，并通知', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const service = makeService(prisma);

    const res = await service.publishBatch(publishInput);
    expect(res).toMatchObject({ batchId: 'batch-1', status: 'PUBLISHED', publishedCount: 1 });

    expect(tx.billBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'batch-1' }),
      data: expect.objectContaining({ status: 'PUBLISHED', publishedBy: 'admin-1' }),
    }));
    expect(tx.bill.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ batchId: 'batch-1', status: 'DRAFT' }),
      data: expect.objectContaining({ status: 'UNPAID' }),
    }));
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'PUBLISH', resourceType: 'BillBatch' }), tx);
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'bill.published', aggregateId: 'bill-1' }), tx);
    expect(notifier.onBillCreated).toHaveBeenCalled();
    expect(idempotency.complete).toHaveBeenCalled();
  });

  it('已发布批次幂等：不重复发布', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    prisma.raw.billBatch.findUnique.mockResolvedValue({ ...draftBatch, status: 'PUBLISHED' });
    const service = makeService(prisma);
    const res = await service.publishBatch(publishInput);
    expect(res.status).toBe('PUBLISHED');
    expect(tx.billBatch.updateMany).not.toHaveBeenCalled();
  });

  it('跨租户批次拒绝发布', async () => {
    const prisma = makePrisma(makeTx());
    const service = makeService(prisma);
    await expect(
      service.publishBatch({ ...publishInput, actingTenantId: 'tenant-OTHER' }),
    ).rejects.toMatchObject({ code: 40300 });
  });

  it('重放已存发布结果', async () => {
    idempotency.reserve.mockResolvedValue({ outcome: 'REPLAY', recordId: 'idem-1', responseBody: { batchId: 'batch-1', status: 'PUBLISHED', publishedCount: 3 } });
    const prisma = makePrisma(makeTx());
    const service = makeService(prisma);
    const res = await service.publishBatch(publishInput);
    expect(res).toEqual({ batchId: 'batch-1', status: 'PUBLISHED', publishedCount: 3 });
  });

  it('作废草稿账单：写原因与审计', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const service = makeService(prisma);
    const res = await service.cancelBill({ billId: 'bill-1', adminId: 'admin-1', actingTenantId: 'tenant-1', reason: '录入错误', requestId: 'req-2' });
    expect(res).toMatchObject({ billId: 'bill-1', status: 'CANCELED' });
    expect(tx.bill.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'bill-1', paymentId: null }),
      data: expect.objectContaining({ status: 'CANCELED', cancelReason: '录入错误', canceledBy: 'admin-1' }),
    }));
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'CANCEL' }), tx);
  });

  it('作废必须填写原因', async () => {
    const prisma = makePrisma(makeTx());
    const service = makeService(prisma);
    await expect(
      service.cancelBill({ billId: 'bill-1', adminId: 'admin-1', actingTenantId: 'tenant-1', reason: '  ', requestId: 'req-3' }),
    ).rejects.toMatchObject({ code: 40000 });
  });

  it('作废存在进行中支付的账单：先查关关单，成功回调则拒绝作废', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    // 账单被支付占用
    prisma.raw.bill.findUnique
      .mockResolvedValueOnce({ ...draftBill, status: 'UNPAID', paymentId: 'payment-1' })
      // 关单后重新加载：支付成功入账
      .mockResolvedValueOnce({ ...draftBill, status: 'PAID', paymentId: 'payment-1' });
    prisma.raw.payment.findUnique.mockResolvedValue({ id: 'payment-1', orderNo: 'WY1' });
    orderCloser.resolveActiveOrder.mockResolvedValue({ orderNo: 'WY1', status: 'SUCCESS' });
    const service = makeService(prisma);
    await expect(
      service.cancelBill({ billId: 'bill-1', adminId: 'admin-1', actingTenantId: 'tenant-1', reason: 'x', requestId: 'req-4' }),
    ).rejects.toMatchObject({ code: 43002 });
    expect(orderCloser.resolveActiveOrder).toHaveBeenCalledWith('WY1');
    expect(tx.bill.updateMany).not.toHaveBeenCalled();
  });

  it('作废存在进行中支付的账单：关单释放后可作废', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    prisma.raw.bill.findUnique
      .mockResolvedValueOnce({ ...draftBill, status: 'UNPAID', paymentId: 'payment-1' })
      .mockResolvedValueOnce({ ...draftBill, status: 'UNPAID', paymentId: null });
    prisma.raw.payment.findUnique.mockResolvedValue({ id: 'payment-1', orderNo: 'WY1' });
    orderCloser.resolveActiveOrder.mockResolvedValue({ orderNo: 'WY1', status: 'CLOSED' });
    const service = makeService(prisma);
    const res = await service.cancelBill({ billId: 'bill-1', adminId: 'admin-1', actingTenantId: 'tenant-1', reason: 'x', requestId: 'req-5' });
    expect(res.status).toBe('CANCELED');
    expect(tx.bill.updateMany).toHaveBeenCalled();
  });

  it('重开账单：仅作废/已退款账单可重开，新账单链接原账单', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    prisma.raw.bill.findUnique.mockResolvedValue({ ...draftBill, status: 'CANCELED' });
    const service = makeService(prisma);
    const res = await service.reissueBill({ billId: 'bill-1', adminId: 'admin-1', actingTenantId: 'tenant-1', reason: '重新出账', requestId: 'req-6' });
    expect(res).toMatchObject({ replacesBillId: 'bill-1', status: 'UNPAID' });
    expect(tx.bill.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ replacesBillId: 'bill-1', status: 'UNPAID', ruleId: null }),
    }));
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE', resourceType: 'Bill' }), tx);
  });

  it('重开非终态账单被拒', async () => {
    const prisma = makePrisma(makeTx());
    prisma.raw.bill.findUnique.mockResolvedValue({ ...draftBill, status: 'UNPAID' });
    const service = makeService(prisma);
    await expect(
      service.reissueBill({ billId: 'bill-1', adminId: 'admin-1', actingTenantId: 'tenant-1', reason: 'x', requestId: 'req-7' }),
    ).rejects.toMatchObject({ code: 40000 });
  });
});
