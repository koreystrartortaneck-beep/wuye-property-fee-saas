import { ReconciliationService } from './reconciliation.service';

describe('ReconciliationService 每日对账', () => {
  let audit: { append: jest.Mock };
  let billProvider: { downloadBill: jest.Mock };
  let recovery: { resolveActiveOrder: jest.Mock };
  let created: any[];

  // Shanghai 账期 2026-07-10：UTC 04:00 → 上海 12:00。
  const businessDate = '2026-07-10';
  const onDate = new Date('2026-07-10T04:00:00.000Z');

  beforeEach(() => {
    jest.clearAllMocks();
    created = [];
    audit = { append: jest.fn().mockResolvedValue(undefined) };
    billProvider = { downloadBill: jest.fn() };
    recovery = { resolveActiveOrder: jest.fn().mockResolvedValue({ status: 'CLOSED' }) };
  });

  function makePrisma(over: Record<string, any> = {}) {
    const tx = {
      reconciliationItem: {
        create: jest.fn(async ({ data }: any) => { created.push(data); return data; }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      reconciliationRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    return {
      raw: {
        reconciliationRun: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'run-1', status: 'RUNNING', differenceRecordCount: 0 }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        reconciliationItem: { findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        payment: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
        refund: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(async (cb: (c: typeof tx) => unknown) => cb(tx)),
        ...over,
      },
    };
  }

  const makeService = (prisma: unknown) =>
    new ReconciliationService(prisma as never, audit as never, billProvider as never, recovery as never);

  const baseInput = {
    tenantId: 'tenant-1', communityId: 'community-1', merchantAccountId: 'SERIAL', mchid: 'MCH', appid: 'APP',
    businessDate, billType: 'TRANSACTION' as const, adminId: 'admin-1',
  };

  it('交易对账：产出 CHANNEL_MISSING / LOCAL_MISSING / AMOUNT_MISMATCH / STATUS_MISMATCH，写审计', async () => {
    const prisma = makePrisma();
    prisma.raw.payment.findMany.mockResolvedValue([
      { id: 'p-match', orderNo: 'WY-MATCH', totalAmount: { toString: () => '100.00' }, status: 'SUCCESS', paidAt: onDate },
      { id: 'p-amt', orderNo: 'WY-AMT', totalAmount: { toString: () => '100.00' }, status: 'SUCCESS', paidAt: onDate },
      { id: 'p-chmiss', orderNo: 'WY-CHMISS', totalAmount: { toString: () => '50.00' }, status: 'SUCCESS', paidAt: onDate },
    ]);
    // WY-STATUS 本地为 CREATED（未终态），恢复查单仍未成功 → STATUS_MISMATCH
    prisma.raw.payment.findFirst.mockImplementation(async ({ where }: any) =>
      where.orderNo === 'WY-STATUS'
        ? { id: 'p-status', orderNo: 'WY-STATUS', totalAmount: { toString: () => '100.00' }, status: 'CREATED', paidAt: onDate }
        : null,
    );
    billProvider.downloadBill.mockResolvedValue({
      billType: 'TRANSACTION', businessDate, fileHash: 'h', recordCount: 4, totalAmountCents: 70000,
      trades: [
        { outTradeNo: 'WY-MATCH', transactionId: 'T1', tradeState: 'SUCCESS', amountCents: 10000 },
        { outTradeNo: 'WY-AMT', transactionId: 'T2', tradeState: 'SUCCESS', amountCents: 20000 },
        { outTradeNo: 'WY-LOCALMISS', transactionId: 'T3', tradeState: 'SUCCESS', amountCents: 30000 },
        { outTradeNo: 'WY-STATUS', transactionId: 'T4', tradeState: 'SUCCESS', amountCents: 10000 },
      ],
      refunds: [],
    });
    const service = makeService(prisma);
    const res = await service.reconcile(baseInput);
    expect(res.status).toBe('COMPLETED');

    const types = created.map((d) => d.differenceType).sort();
    expect(types).toEqual(['AMOUNT_MISMATCH', 'CHANNEL_MISSING', 'LOCAL_MISSING', 'STATUS_MISMATCH']);
    expect(recovery.resolveActiveOrder).toHaveBeenCalledWith('WY-STATUS');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'RECONCILE', resourceType: 'ReconciliationRun' }), expect.anything());
  });

  it('渠道成功且本地可恢复 → STATUS_MISMATCH 自动本地确认 AUTO_RESOLVED', async () => {
    const prisma = makePrisma();
    prisma.raw.payment.findFirst.mockResolvedValue({ id: 'p-status', orderNo: 'WY-AUTO', totalAmount: { toString: () => '100.00' }, status: 'PREPAY_UNKNOWN', paidAt: onDate });
    recovery.resolveActiveOrder.mockResolvedValue({ orderNo: 'WY-AUTO', status: 'SUCCESS' });
    billProvider.downloadBill.mockResolvedValue({
      billType: 'TRANSACTION', businessDate, fileHash: 'h', recordCount: 1, totalAmountCents: 10000,
      trades: [{ outTradeNo: 'WY-AUTO', transactionId: 'T', tradeState: 'SUCCESS', amountCents: 10000 }], refunds: [],
    });
    const service = makeService(prisma);
    await service.reconcile(baseInput);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ differenceType: 'STATUS_MISMATCH', status: 'AUTO_RESOLVED' });
  });

  it('退款对账：金额不一致 → REFUND_MISMATCH', async () => {
    const prisma = makePrisma();
    prisma.raw.refund.findFirst.mockResolvedValue({ id: 'r-1', refundNo: 'RF-1', refundAmount: { toString: () => '100.00' }, status: 'SUCCESS', refundedAt: onDate });
    billProvider.downloadBill.mockResolvedValue({
      billType: 'REFUND', businessDate, fileHash: 'h', recordCount: 1, totalAmountCents: 5000,
      trades: [], refunds: [{ outTradeNo: 'WY-1', outRefundNo: 'RF-1', refundState: 'SUCCESS', refundCents: 5000 }],
    });
    const service = makeService(prisma);
    await service.reconcile({ ...baseInput, billType: 'REFUND' });
    expect(created.map((d) => d.differenceType)).toContain('REFUND_MISMATCH');
  });

  it('已完成的 Run 幂等：不重复下载对账单', async () => {
    const prisma = makePrisma();
    prisma.raw.reconciliationRun.findFirst.mockResolvedValue({ id: 'run-1', status: 'COMPLETED', differenceRecordCount: 2 });
    const service = makeService(prisma);
    const res = await service.reconcile(baseInput);
    expect(res).toMatchObject({ runId: 'run-1', status: 'COMPLETED', differenceRecordCount: 2 });
    expect(billProvider.downloadBill).not.toHaveBeenCalled();
  });

  it('租约被他人持有且未过期 → 跳过', async () => {
    const prisma = makePrisma();
    prisma.raw.reconciliationRun.findFirst.mockResolvedValue({
      id: 'run-1', status: 'RUNNING', differenceRecordCount: 0,
      leaseOwner: 'other', leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const service = makeService(prisma);
    await service.reconcile(baseInput);
    expect(billProvider.downloadBill).not.toHaveBeenCalled();
  });

  it('手工处置差异项：MANUALLY_CLOSED 并写审计', async () => {
    const prisma = makePrisma();
    prisma.raw.reconciliationItem.findUnique.mockResolvedValue({ id: 'item-1', tenantId: 'tenant-1', communityId: 'community-1', status: 'OPEN' });
    const service = makeService(prisma);
    const res = await service.resolveItem({ itemId: 'item-1', adminId: 'admin-1', actingTenantId: 'tenant-1', status: 'MANUALLY_CLOSED', remark: '已核实' });
    expect(res.status).toBe('MANUALLY_CLOSED');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'RECONCILE', resourceType: 'ReconciliationItem' }), expect.anything());
  });
});
