import { MODULE_METADATA } from '@nestjs/common/constants';
import { InvoiceService, INVOICE_REFUND_LINK } from './invoice.service';
import { InvoiceModule } from './invoice.module';

describe('InvoiceService 开票申请与状态机', () => {
  let audit: { append: jest.Mock };
  let outbox: { enqueue: jest.Mock };
  let idempotency: { reserve: jest.Mock; complete: jest.Mock; fail: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    audit = { append: jest.fn().mockResolvedValue(undefined) };
    outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    idempotency = {
      reserve: jest.fn().mockResolvedValue({ outcome: 'RESERVED', recordId: 'idem-1' }),
      complete: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    };
  });

  const payment = {
    id: 'payment-1',
    tenantId: 'tenant-1',
    communityId: 'community-1',
    orderNo: 'WY202607220001',
    wxUserId: 'wx-1',
    status: 'SUCCESS',
    totalAmount: { toString: () => '1.00' },
    paymentBills: [{ bill: { communityId: 'community-1' } }],
  };

  const applyInput = {
    orderNo: 'WY202607220001',
    wxUserId: 'wx-1',
    titleType: 'PERSONAL' as const,
    title: '张三',
    deliveryMethod: 'NONE',
    requestId: 'req-1',
  };

  function makeTx() {
    return {
      invoiceApplication: {
        create: jest.fn().mockResolvedValue({
          id: 'inv-1',
          applicationNo: 'INV-WY202607220001',
          status: 'SUBMITTED',
          titleType: 'PERSONAL',
          title: '张三',
          taxNo: null,
          amount: { toString: () => '1.00' },
          invoiceNo: null,
          appliedAt: new Date('2026-07-22T00:00:00Z'),
          issuedAt: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
  }

  function makePrisma(tx: ReturnType<typeof makeTx>, overrides: Record<string, unknown> = {}) {
    return {
      raw: {
        payment: { findUnique: jest.fn().mockResolvedValue(payment) },
        invoiceApplication: {
          findFirst: jest.fn().mockResolvedValue(null),
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        $transaction: jest.fn(async (cb: (client: typeof tx) => unknown) => cb(tx)),
        ...(overrides.raw as object),
      },
    };
  }

  function makeService(prisma: unknown): InvoiceService {
    return new InvoiceService(prisma as never, audit as never, outbox as never, idempotency as never);
  }

  it('模块注册并导出 InvoiceService 与退款联动令牌', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, InvoiceModule)).toEqual(
      expect.arrayContaining([InvoiceService]),
    );
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, InvoiceModule)).toEqual(
      expect.arrayContaining([InvoiceService, INVOICE_REFUND_LINK]),
    );
  });

  it('支付成功可开票：创建 SUBMITTED、事务内写审计与 Outbox 事件', async () => {
    const tx = makeTx();
    const service = makeService(makePrisma(tx));

    const result = await service.apply(applyInput);

    expect(result).toMatchObject({ applicationNo: 'INV-WY202607220001', status: 'SUBMITTED' });
    expect(tx.invoiceApplication.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUBMITTED', paymentId: 'payment-1' }) }),
    );
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'INVOICE' }), tx);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'invoice.submitted', aggregateType: 'InvoiceApplication' }),
      tx,
    );
    expect(idempotency.complete).toHaveBeenCalled();
  });

  it('非成功支付订单不可开票', async () => {
    const service = makeService(makePrisma(makeTx(), { raw: { payment: { findUnique: jest.fn().mockResolvedValue({ ...payment, status: 'CREATED' }) } } }));
    await expect(service.apply(applyInput)).rejects.toMatchObject({ code: 40000 });
  });

  it('非本人订单开票被拒', async () => {
    const service = makeService(makePrisma(makeTx(), { raw: { payment: { findUnique: jest.fn().mockResolvedValue({ ...payment, wxUserId: 'other' }) } } }));
    await expect(service.apply(applyInput)).rejects.toMatchObject({ code: 40300 });
  });

  it('企业抬头必须提供正确税号', async () => {
    const service = makeService(makePrisma(makeTx()));
    await expect(service.apply({ ...applyInput, titleType: 'ENTERPRISE' })).rejects.toMatchObject({ code: 40000 });
    await expect(service.apply({ ...applyInput, titleType: 'ENTERPRISE', taxNo: 'bad!' })).rejects.toMatchObject({ code: 40000 });
  });

  it('重复申请幂等：已存在申请直接返回，不再预留幂等或创建', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    (prisma.raw.invoiceApplication.findFirst as jest.Mock).mockResolvedValue({
      id: 'inv-1', applicationNo: 'INV-WY202607220001', status: 'SUBMITTED', titleType: 'PERSONAL',
      title: '张三', taxNo: null, amount: { toString: () => '1.00' }, invoiceNo: null,
      appliedAt: new Date(), issuedAt: null,
    });
    const service = makeService(prisma);

    const result = await service.apply(applyInput);
    expect(result).toMatchObject({ applicationNo: 'INV-WY202607220001' });
    expect(idempotency.reserve).not.toHaveBeenCalled();
    expect(tx.invoiceApplication.create).not.toHaveBeenCalled();
  });

  it('requestId 重放直接返回已存结果', async () => {
    idempotency.reserve.mockResolvedValue({ outcome: 'REPLAY', recordId: 'idem-1', responseBody: { applicationNo: 'INV-WY202607220001', status: 'SUBMITTED' } });
    const tx = makeTx();
    const service = makeService(makePrisma(tx));
    const result = await service.apply(applyInput);
    expect(result).toMatchObject({ applicationNo: 'INV-WY202607220001' });
    expect(tx.invoiceApplication.create).not.toHaveBeenCalled();
  });

  describe('管理端状态流转', () => {
    function transitionPrisma(app: Record<string, unknown>) {
      const tx = { invoiceApplication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
      const prisma = {
        raw: {
          invoiceApplication: { findUnique: jest.fn().mockResolvedValue(app) },
          $transaction: jest.fn(async (cb: (client: typeof tx) => unknown) => cb(tx)),
        },
      };
      return { prisma, tx };
    }

    it('SUBMITTED→ISSUED 记录发票号并写审计/Outbox', async () => {
      const { prisma, tx } = transitionPrisma({ id: 'inv-1', tenantId: 'tenant-1', communityId: 'community-1', status: 'SUBMITTED', applicationNo: 'INV-1', wxUserId: 'wx-1' });
      const service = makeService(prisma);
      await service.transition({ id: 'inv-1', adminId: 'admin-1', actingTenantId: 'tenant-1', status: 'ISSUED', invoiceNo: 'FP-001' });
      expect(tx.invoiceApplication.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ISSUED', invoiceNo: 'FP-001' }) }),
      );
      expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'INVOICE' }), tx);
      expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'invoice.issued' }), tx);
    });

    it('非法状态流转被拒', async () => {
      const { prisma } = transitionPrisma({ id: 'inv-1', tenantId: 'tenant-1', communityId: 'community-1', status: 'ISSUED', applicationNo: 'INV-1', wxUserId: 'wx-1' });
      const service = makeService(prisma);
      await expect(service.transition({ id: 'inv-1', adminId: 'admin-1', actingTenantId: 'tenant-1', status: 'PROCESSING' })).rejects.toMatchObject({ code: 40000 });
    });

    it('跨租户处理开票申请被拒', async () => {
      const { prisma } = transitionPrisma({ id: 'inv-1', tenantId: 'tenant-1', communityId: 'community-1', status: 'SUBMITTED', applicationNo: 'INV-1', wxUserId: 'wx-1' });
      const service = makeService(prisma);
      await expect(service.transition({ id: 'inv-1', adminId: 'admin-1', actingTenantId: 'tenant-2', status: 'ISSUED' })).rejects.toMatchObject({ code: 40300 });
    });
  });

  describe('退款联动 onPaymentRefunded', () => {
    it('未开票申请置 CANCELED 并写审计', async () => {
      const tx = {
        invoiceApplication: {
          findFirst: jest.fn().mockResolvedValue({ id: 'inv-1', communityId: 'community-1', status: 'SUBMITTED' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const service = makeService(makePrisma(makeTx()));
      await service.onPaymentRefunded(tx as never, 'tenant-1', 'payment-1');
      expect(tx.invoiceApplication.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELED' }) }),
      );
      expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ afterSummary: expect.objectContaining({ status: 'CANCELED' }) }), tx);
    });

    it('已开票申请转 REVERSAL_REQUIRED 生成冲红任务', async () => {
      const tx = {
        invoiceApplication: {
          findFirst: jest.fn().mockResolvedValue({ id: 'inv-1', communityId: 'community-1', status: 'ISSUED' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const service = makeService(makePrisma(makeTx()));
      await service.onPaymentRefunded(tx as never, 'tenant-1', 'payment-1');
      expect(tx.invoiceApplication.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'REVERSAL_REQUIRED' }) }),
      );
    });

    it('无开票申请时安全跳过', async () => {
      const tx = { invoiceApplication: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() } };
      const service = makeService(makePrisma(makeTx()));
      await expect(service.onPaymentRefunded(tx as never, 'tenant-1', 'payment-1')).resolves.toBeUndefined();
      expect(tx.invoiceApplication.updateMany).not.toHaveBeenCalled();
    });
  });
});
