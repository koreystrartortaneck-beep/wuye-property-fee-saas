import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import type { CollectionPolicyService } from './collection-policy.service';
import { PaymentService } from './payment.service';
import { PaymentProviderError, type PaymentProvider, type WxPayTransaction } from './provider';

describe('PaymentService', () => {
  const provider = { createOrder: jest.fn(), close: jest.fn() } as PaymentProvider;
  let collectionPolicy: CollectionPolicyService;
  let idempotency: { reserve: jest.Mock; complete: jest.Mock; fail: jest.Mock };
  let audit: { append: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    collectionPolicy = {
      assertOpenForUpdate: jest.fn().mockResolvedValue(undefined),
      resolveEffectiveStatus: jest.fn().mockResolvedValue({ status: 'OPEN', pausedLayer: null, reason: null }),
    } as unknown as CollectionPolicyService;
    idempotency = {
      reserve: jest.fn().mockResolvedValue({ outcome: 'RESERVED', recordId: 'idem-1', requestHash: 'hash-1' }),
      complete: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    };
    audit = { append: jest.fn().mockResolvedValue(undefined) };
  });

  function makeService(prisma: unknown, providerImpl: PaymentProvider = provider): PaymentService {
    return new PaymentService(
      prisma as never,
      providerImpl,
      collectionPolicy,
      idempotency as never,
      audit as never,
    );
  }

  function transaction(overrides: Partial<WxPayTransaction> = {}): WxPayTransaction {
    return {
      appid: 'wx-appid',
      mchid: '1900000109',
      out_trade_no: 'WY202607220001',
      transaction_id: '420000000001',
      trade_state: 'SUCCESS',
      success_time: '2026-07-22T10:00:00+08:00',
      amount: { total: 100, currency: 'CNY' },
      ...overrides,
    };
  }

  const bill = {
    id: 'bill-1',
    tenantId: 'tenant-1',
    communityId: 'community-1',
    houseId: 'house-1',
    title: '物业费',
    amount: { toString: () => '1.00' },
    status: 'UNPAID',
  };

  function createTx(overrides: Record<string, unknown> = {}) {
    return {
      payment: {
        create: jest.fn().mockResolvedValue({ id: 'payment-1', orderNo: 'WY202607220001', totalAmount: '1.00' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      paymentBill: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn() },
      $queryRaw: jest.fn(),
      ...overrides,
    };
  }

  function createPrisma(tx: ReturnType<typeof createTx>, overrides: Record<string, unknown> = {}) {
    return {
      raw: {
        bill: { findUnique: jest.fn().mockResolvedValue(bill) },
        houseBinding: { findFirst: jest.fn().mockResolvedValue({ houseId: 'house-1' }) },
        paymentBill: { findFirst: jest.fn().mockResolvedValue(null) },
        wxUser: { findUnique: jest.fn().mockResolvedValue({ openid: 'openid-1' }) },
        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      },
      ...overrides,
    };
  }

  describe('createPayment 单账单单支付', () => {
    it('拒绝数组入参，只接受单个 billId', async () => {
      const service = makeService(createPrisma(createTx()));
      await expect(
        service.createPayment('owner-1', ['bill-1'] as never, 'req-1'),
      ).rejects.toMatchObject({ code: 40000 });
      expect(idempotency.reserve).not.toHaveBeenCalled();
    });

    it('缺少 requestId 时拒绝', async () => {
      const service = makeService(createPrisma(createTx()));
      await expect(service.createPayment('owner-1', 'bill-1', '')).rejects.toMatchObject({ code: 40000 });
    });

    it('以单账单创建订单：写入 billId/communityId、事务内审计、预占账单并保留 PaymentBill', async () => {
      const tx = createTx();
      const prisma = createPrisma(tx);
      (provider.createOrder as jest.Mock).mockResolvedValue({ mock: true });
      const service = makeService(prisma);

      const res = await service.createPayment('owner-1', 'bill-1', 'req-1');

      expect(res).toMatchObject({ orderNo: 'WY202607220001', payParams: { mock: true } });
      expect(tx.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: 'tenant-1',
          communityId: 'community-1',
          billId: 'bill-1',
          wxUserId: 'owner-1',
          status: 'CREATED',
        }),
      });
      expect(tx.paymentBill.create).toHaveBeenCalledWith({ data: { paymentId: 'payment-1', billId: 'bill-1' } });
      expect(audit.append).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CREATE', resourceType: 'Payment', resourceId: 'payment-1' }),
        tx,
      );
      expect(idempotency.reserve).toHaveBeenCalledWith(
        expect.objectContaining({ actorKey: 'owner-1', requestId: 'req-1', payload: { billId: 'bill-1' } }),
      );
      expect(idempotency.complete).toHaveBeenCalledWith(
        expect.objectContaining({ recordId: 'idem-1', responseCode: 0 }),
      );
    });

    it('相同幂等键重放时直接返回已存结果，不重复下单', async () => {
      const stored = { orderNo: 'WY202607220001', totalAmount: '1.00', payParams: { mock: true } };
      idempotency.reserve.mockResolvedValue({ outcome: 'REPLAY', recordId: 'idem-1', responseCode: 0, responseBody: stored });
      const tx = createTx();
      const prisma = createPrisma(tx);
      const service = makeService(prisma);

      await expect(service.createPayment('owner-1', 'bill-1', 'req-1')).resolves.toEqual(stored);
      expect(prisma.raw.$transaction).not.toHaveBeenCalled();
      expect(provider.createOrder).not.toHaveBeenCalled();
    });

    it('允许历史失败订单的账单重新发起支付（仅进行中订单才占用）', async () => {
      const tx = createTx();
      const prisma = createPrisma(tx);
      (provider.createOrder as jest.Mock).mockResolvedValue({ mock: true });
      const service = makeService(prisma);

      await service.createPayment('owner-1', 'bill-1', 'req-2');
      // 占用查询只看进行中订单（CREATED / PREPAY_UNKNOWN）
      expect(prisma.raw.paymentBill.findFirst).toHaveBeenCalledWith({
        where: { billId: 'bill-1', payment: { status: { in: ['CREATED', 'PREPAY_UNKNOWN'] } } },
      });
    });

    it('收款暂停时事务内复核拒绝新支付且不下单', async () => {
      const tx = createTx();
      const prisma = createPrisma(tx);
      (collectionPolicy.assertOpenForUpdate as jest.Mock).mockRejectedValue(
        new BizException(ErrorCode.COLLECTION_PAUSED),
      );
      const service = makeService(prisma);

      await expect(service.createPayment('owner-1', 'bill-1', 'req-3')).rejects.toMatchObject({ code: 43003 });
      expect(collectionPolicy.assertOpenForUpdate).toHaveBeenCalledWith(tx, 'tenant-1', ['community-1']);
      expect(tx.payment.create).not.toHaveBeenCalled();
      expect(provider.createOrder).not.toHaveBeenCalled();
      expect(idempotency.fail).toHaveBeenCalled();
    });

    it('WXPAY 渠道拒绝超出开通范围的小区', async () => {
      const prev = { ...process.env };
      process.env.PAY_MODE = 'wxpay';
      process.env.WX_PAY_ALLOWED_TENANT_ID = 'tenant-1';
      process.env.WX_PAY_ALLOWED_COMMUNITY_ID = 'community-allowed';
      const prisma = createPrisma(createTx());
      const service = makeService(prisma);

      await expect(service.createPayment('owner-1', 'bill-1', 'req-4')).rejects.toMatchObject({ code: 43004 });
      expect(prisma.raw.$transaction).not.toHaveBeenCalled();

      process.env = prev;
    });

    it('微信明确拒绝预下单时立即释放账单并置失败', async () => {
      const tx = createTx();
      const prisma = createPrisma(tx);
      const rejectProvider = {
        createOrder: jest.fn().mockRejectedValue(new PaymentProviderError(400, 'PARAM_ERROR', '参数错误')),
        close: jest.fn(),
      } as unknown as PaymentProvider;
      const service = makeService(prisma, rejectProvider);

      await expect(service.createPayment('owner-1', 'bill-1', 'req-5')).rejects.toThrow('参数错误');
      // 释放账单预占（status CREATED/PREPAY_UNKNOWN → FAILED，账单 paymentId 置空）
      expect(tx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: { status: 'FAILED' },
      }));
      expect(tx.bill.updateMany).toHaveBeenCalledWith({
        where: { paymentId: 'payment-1', status: 'UNPAID' },
        data: { paymentId: null },
      });
      expect(idempotency.fail).toHaveBeenCalled();
    });

    it('预下单网络超时转 PREPAY_UNKNOWN，账单保持预占等待恢复查单', async () => {
      const tx = createTx();
      const prisma = createPrisma(tx);
      const timeoutProvider = {
        createOrder: jest.fn().mockRejectedValue(new Error('network timeout')),
        close: jest.fn(),
      } as unknown as PaymentProvider;
      const service = makeService(prisma, timeoutProvider);

      const res = await service.createPayment('owner-1', 'bill-1', 'req-6');
      expect(res).toMatchObject({ orderNo: 'WY202607220001', status: 'PREPAY_UNKNOWN' });
      expect(prisma.raw.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'payment-1', status: 'CREATED' },
        data: { status: 'PREPAY_UNKNOWN' },
      });
      // 未释放账单：不应出现将 bill.paymentId 置空的调用
      expect(idempotency.complete).toHaveBeenCalled();
      expect(idempotency.fail).not.toHaveBeenCalled();
    });
  });

  describe('回调 / 查单 / 恢复', () => {
    it('Mock 模式也不能确认 WXPAY 渠道订单', async () => {
      const prev = { ...process.env };
      process.env.PAY_MODE = 'mock';
      process.env.ALLOW_MOCK_PAYMENTS = 'true';
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue({
            id: 'payment-1', wxUserId: 'owner-1', channel: 'WXPAY', status: 'CREATED',
            paymentBills: [{ billId: 'bill-1' }],
          }) },
        },
      };
      const service = makeService(prisma);
      await expect(service.mockConfirm('owner-1', 'WY1')).rejects.toThrow('真实支付订单不可 mock 确认');
      process.env = prev;
    });

    it('核对金额后原子更新订单与账单（同时接受 PREPAY_UNKNOWN 入账）', async () => {
      const payment = {
        id: 'payment-1', orderNo: 'WY202607220001', totalAmount: { toString: () => '1.00' },
        channel: 'WXPAY', status: 'CREATED', transactionId: null,
        paymentBills: [{ billId: 'bill-1' }, { billId: 'bill-2' }],
      };
      const tx = {
        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      };
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue(payment) },
          $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
        },
      };
      const service = makeService(prisma);

      await expect(service.handleWxPaySuccess(transaction())).resolves.toEqual({
        orderNo: payment.orderNo, status: 'SUCCESS',
      });
      expect(tx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: payment.id, status: { in: ['CREATED', 'PREPAY_UNKNOWN'] } },
        data: expect.objectContaining({ status: 'SUCCESS', transactionId: '420000000001' }),
      }));
      expect(tx.bill.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: { in: ['bill-1', 'bill-2'] }, status: 'UNPAID', paymentId: payment.id },
        data: expect.objectContaining({ status: 'PAID' }),
      }));
    });

    it('收款暂停不影响支付回调入账', async () => {
      const payment = {
        id: 'payment-1', orderNo: 'WY202607220001', totalAmount: { toString: () => '1.00' },
        channel: 'WXPAY', status: 'CREATED', transactionId: null, paymentBills: [{ billId: 'bill-1' }],
      };
      const tx = {
        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue(payment) },
          $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
        },
      };
      const service = makeService(prisma);
      await service.handleWxPaySuccess(transaction());
      expect(collectionPolicy.assertOpenForUpdate).not.toHaveBeenCalled();
    });

    it('金额不一致时拒绝入账', async () => {
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue({
            id: 'payment-1', totalAmount: { toString: () => '2.00' }, channel: 'WXPAY',
            status: 'CREATED', paymentBills: [{ billId: 'bill-1' }],
          }) },
          $transaction: jest.fn(),
        },
      };
      const service = makeService(prisma);
      await expect(service.handleWxPaySuccess(transaction())).rejects.toThrow('支付回调金额不一致');
      expect(prisma.raw.$transaction).not.toHaveBeenCalled();
    });

    it('同一微信交易号的重复回调幂等成功', async () => {
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue({
            id: 'payment-1', orderNo: 'WY202607220001', totalAmount: { toString: () => '1.00' },
            channel: 'WXPAY', status: 'SUCCESS', transactionId: '420000000001',
            paymentBills: [{ billId: 'bill-1' }],
          }) },
          $transaction: jest.fn(),
        },
      };
      const service = makeService(prisma);
      await expect(service.handleWxPaySuccess(transaction())).resolves.toEqual({
        orderNo: 'WY202607220001', status: 'SUCCESS',
      });
      expect(prisma.raw.$transaction).not.toHaveBeenCalled();
    });

    it('用户取消未支付订单时关单并释放账单预占', async () => {
      const payment = {
        id: 'payment-1', wxUserId: 'owner-1', orderNo: 'WY202607220001', channel: 'WXPAY', status: 'CREATED',
      };
      const tx = {
        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue(payment) },
          $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
        },
      };
      const queryProvider = {
        createOrder: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
        queryOrder: jest.fn().mockResolvedValue(transaction({ trade_state: 'NOTPAY' })),
      } as PaymentProvider;
      const service = makeService(prisma, queryProvider);

      await expect(service.cancelWxPay('owner-1', payment.orderNo)).resolves.toEqual({
        orderNo: payment.orderNo, status: 'CLOSED',
      });
      expect(queryProvider.close).toHaveBeenCalledWith(payment.orderNo);
      expect(tx.bill.updateMany).toHaveBeenCalledWith({
        where: { paymentId: payment.id, status: 'UNPAID' },
        data: { paymentId: null },
      });
    });

    it('超时订单在微信侧不存在时标记失败并释放账单', async () => {
      const payment = { id: 'payment-1', orderNo: 'WY202607220001', channel: 'WXPAY', status: 'CREATED' };
      const tx = {
        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue(payment) },
          $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
        },
      };
      const queryProvider = {
        createOrder: jest.fn(),
        close: jest.fn(),
        queryOrder: jest.fn().mockRejectedValue(new PaymentProviderError(404, 'ORDER_NOT_EXIST', 'not found')),
      } as PaymentProvider;
      const service = makeService(prisma, queryProvider);

      await expect(service.reconcileStaleWxPay(payment.orderNo)).resolves.toEqual({
        orderNo: payment.orderNo, status: 'FAILED',
      });
      expect(tx.bill.updateMany).toHaveBeenCalledWith({
        where: { paymentId: payment.id, status: 'UNPAID' },
        data: { paymentId: null },
      });
    });

    it('恢复任务同样处理 PREPAY_UNKNOWN 订单并可查得成功入账', async () => {
      const payment = {
        id: 'payment-1', orderNo: 'WY202607220001', totalAmount: { toString: () => '1.00' },
        channel: 'WXPAY', status: 'PREPAY_UNKNOWN', transactionId: null, paymentBills: [{ billId: 'bill-1' }],
      };
      const tx = {
        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue(payment) },
          $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
        },
      };
      const queryProvider = {
        createOrder: jest.fn(), close: jest.fn(),
        queryOrder: jest.fn().mockResolvedValue(transaction()),
      } as PaymentProvider;
      const service = makeService(prisma, queryProvider);

      await expect(service.reconcileStaleWxPay(payment.orderNo)).resolves.toEqual({
        orderNo: payment.orderNo, status: 'SUCCESS',
      });
      expect(tx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: payment.id, status: { in: ['CREATED', 'PREPAY_UNKNOWN'] } },
      }));
    });

    it('主动查单发现 SUCCESS 时走同一幂等入账逻辑', async () => {
      const payment = {
        id: 'payment-1', wxUserId: 'owner-1', orderNo: 'WY202607220001', totalAmount: { toString: () => '1.00' },
        channel: 'WXPAY', status: 'CREATED', transactionId: null, paymentBills: [{ billId: 'bill-1' }],
      };
      const tx = {
        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue(payment) },
          $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
        },
      };
      const queryProvider = {
        createOrder: jest.fn(), close: jest.fn(),
        queryOrder: jest.fn().mockResolvedValue(transaction()),
      } as PaymentProvider;
      const service = makeService(prisma, queryProvider);

      await expect(service.syncWxPay('owner-1', payment.orderNo)).resolves.toEqual({
        orderNo: payment.orderNo, status: 'SUCCESS',
      });
      expect(queryProvider.queryOrder).toHaveBeenCalledWith(payment.orderNo);
      expect(tx.payment.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});
