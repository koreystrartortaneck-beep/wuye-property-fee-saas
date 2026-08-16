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
      { autoGrantOnPayment: jest.fn(async () => undefined) } as never,
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
        // finishUnpaidPayment 现在在事务内读订单上的券并退还（时序修正，见 A6）
        findUnique: jest.fn().mockResolvedValue({ userCouponId: null }),
      },
      userCoupon: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      // 入账会写一条 CONFIRMED 事件（同事务）——纯查单入账的订单原本时间线是空的
      paymentEvent: { create: jest.fn().mockResolvedValue({}) },
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
        payment: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          // releaseCouponFor 会在关单/失败时读订单上的 userCouponId
          findUnique: jest.fn().mockResolvedValue({ userCouponId: null }),
        },
        userCoupon: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
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

    /*
     * 资金安全（真实路径断言）。
     *
     * 事故链：Payment.totalAmount 落库的是券抵扣后的金额，而 provider.createOrder
     * 传的是账单原额。业主一用券，微信就按原价扣款成功，回调带回原额与本地记录不符，
     * handleWxPayNotification 判「支付回调金额不一致」抛错，微信重试仍失败，
     * queryAndReconcile 有同样校验也救不回来——业主付了原价、账单永远停在未缴。
     *
     * 此前 coupon-deduction.spec 只测了抵扣算术，从没断言下单金额，所以完全没拦住。
     * 这两条直接在 createPayment 上断言：给微信的分值必须等于落库金额换算出的分值。
     */
    it('向微信下单的金额必须等于落库的实付金额（不用券）', async () => {
      const tx = createTx();
      const prisma = createPrisma(tx);
      (provider.createOrder as jest.Mock).mockResolvedValue({ mock: true });

      await makeService(prisma).createPayment('owner-1', 'bill-1', 'req-amount-1');

      // 账单 1.00 元、未用券 → 落库 totalAmount '1.00' → 应向微信收 100 分
      expect(provider.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({ orderNo: 'WY202607220001', totalCents: 100 }),
      );
    });

    it('用券后向微信下单的金额是抵扣后的实付额，绝不是账单原额', async () => {
      // 账单 250.00 元，券抵 30.00 元 → 落库 220.00 → 应向微信收 22000 分
      const bigBill = { ...bill, amount: { toString: () => '250.00' } };
      const tx = createTx({
        payment: {
          create: jest.fn().mockResolvedValue({
            id: 'payment-1',
            orderNo: 'WY202607220001',
            totalAmount: '220.00',
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        userCoupon: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'uc1',
            status: 'UNUSED',
            coupon: {
              enabled: true,
              communityId: null,
              faceValue: { toString: () => '30.00' },
              threshold: null,
              validFrom: new Date(Date.now() - 86_400_000),
              validTo: new Date(Date.now() + 86_400_000),
            },
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma = createPrisma(tx, {
        raw: {
          ...createPrisma(tx).raw,
          bill: { findUnique: jest.fn().mockResolvedValue(bigBill) },
        },
      });
      (provider.createOrder as jest.Mock).mockResolvedValue({ mock: true });

      await makeService(prisma).createPayment('owner-1', 'bill-1', 'req-amount-2', 'uc1');

      expect(provider.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({ totalCents: 22000 }),
      );
      // 25000 分正是修复前实际发给微信的错误值
      expect(provider.createOrder).not.toHaveBeenCalledWith(
        expect.objectContaining({ totalCents: 25000 }),
      );
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
        expect.objectContaining({
          actorKey: 'owner-1',
          requestId: 'req-1',
          // 载荷含 userCouponId：换券后复用同一 requestId 不应被当成重放
          payload: { billId: 'bill-1', userCouponId: null },
        }),
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
        payment: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          // 退券已挪进事务（时序修正），关单路径会在事务内读订单上的券
          findUnique: jest.fn().mockResolvedValue({ userCouponId: null }),
        },
        userCoupon: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
        // 入账会写一条 CONFIRMED 事件（同事务）——纯查单入账的订单原本时间线是空的
        paymentEvent: { create: jest.fn().mockResolvedValue({}) },
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
        payment: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          // 退券已挪进事务（时序修正），关单路径会在事务内读订单上的券
          findUnique: jest.fn().mockResolvedValue({ userCouponId: null }),
        },
        userCoupon: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        // 入账会写一条 CONFIRMED 事件（同事务）——纯查单入账的订单原本时间线是空的
        paymentEvent: { create: jest.fn().mockResolvedValue({}) },
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
        payment: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          // 退券已挪进事务（时序修正），关单路径会在事务内读订单上的券
          findUnique: jest.fn().mockResolvedValue({ userCouponId: null }),
        },
        userCoupon: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        // 入账会写一条 CONFIRMED 事件（同事务）——纯查单入账的订单原本时间线是空的
        paymentEvent: { create: jest.fn().mockResolvedValue({}) },
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
        payment: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          // 退券已挪进事务（时序修正），关单路径会在事务内读订单上的券
          findUnique: jest.fn().mockResolvedValue({ userCouponId: null }),
        },
        userCoupon: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        // 入账会写一条 CONFIRMED 事件（同事务）——纯查单入账的订单原本时间线是空的
        paymentEvent: { create: jest.fn().mockResolvedValue({}) },
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
        payment: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          // 退券已挪进事务（时序修正），关单路径会在事务内读订单上的券
          findUnique: jest.fn().mockResolvedValue({ userCouponId: null }),
        },
        userCoupon: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        // 入账会写一条 CONFIRMED 事件（同事务）——纯查单入账的订单原本时间线是空的
        paymentEvent: { create: jest.fn().mockResolvedValue({}) },
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
        payment: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          // 退券已挪进事务（时序修正），关单路径会在事务内读订单上的券
          findUnique: jest.fn().mockResolvedValue({ userCouponId: null }),
        },
        userCoupon: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        // 入账会写一条 CONFIRMED 事件（同事务）——纯查单入账的订单原本时间线是空的
        paymentEvent: { create: jest.fn().mockResolvedValue({}) },
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

  describe('allowClose：不许写未支付终态时，只查不动', () => {
    /*
     * 2026-08-01 事故的修复配套。查单窗口从 30 分钟缩到 2 分钟，
     * 让「付了钱但回调没到」能几分钟内自动入账；
     * 代价是这个方法会被很年轻的订单调用 —— 此时业主可能正在收银台输密码，
     * 任何「未支付终态」的写入都会把他正在进行的支付作废。
     * 所以 allowClose: false 时必须只读：不 close、不落库、不释放账单。
     */
    function makeNotpayHarness(tradeState: 'NOTPAY' | 'ERR') {
      const payment = { id: 'payment-1', orderNo: 'WY202608010001', channel: 'WXPAY', status: 'CREATED' };
      const tx = {
        payment: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({ userCouponId: null }),
        },
        userCoupon: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        // 入账会写一条 CONFIRMED 事件（同事务）——纯查单入账的订单原本时间线是空的
        paymentEvent: { create: jest.fn().mockResolvedValue({}) },
      };
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue(payment) },
          $transaction: jest.fn(async (cb: (c: typeof tx) => unknown) => cb(tx)),
        },
      };
      const close = jest.fn();
      const queryProvider = {
        createOrder: jest.fn(),
        close,
        queryOrder:
          tradeState === 'NOTPAY'
            ? jest.fn().mockResolvedValue(transaction({ trade_state: 'NOTPAY' }))
            : jest.fn().mockRejectedValue(new PaymentProviderError(404, 'ORDER_NOT_EXIST', 'not found')),
      } as PaymentProvider;
      return { payment, tx, close, service: makeService(prisma, queryProvider) };
    }

    it('NOTPAY + allowClose:false → 保持原状，不关单、不释放账单', async () => {
      const { payment, tx, close, service } = makeNotpayHarness('NOTPAY');
      await expect(service.reconcileStaleWxPay(payment.orderNo, { allowClose: false })).resolves.toEqual({
        orderNo: payment.orderNo,
        status: 'CREATED',
      });
      expect(close).not.toHaveBeenCalled();
      expect(tx.payment.updateMany).not.toHaveBeenCalled();
      expect(tx.bill.updateMany).not.toHaveBeenCalled();
    });

    it('NOTPAY + allowClose:true → 照旧关单', async () => {
      const { payment, close, service } = makeNotpayHarness('NOTPAY');
      await expect(service.reconcileStaleWxPay(payment.orderNo, { allowClose: true })).resolves.toEqual({
        orderNo: payment.orderNo,
        status: 'CLOSED',
      });
      expect(close).toHaveBeenCalledWith(payment.orderNo);
    });

    it('微信查无此单 + allowClose:false → 也不判失败', async () => {
      /*
       * 刚下单的订单在微信侧可能短时间内还查不到，而 FAILED 是终态、会释放账单。
       * 30 分钟的窗口里这不成问题，2 分钟的窗口里它是新的误判来源。
       */
      const { payment, tx, service } = makeNotpayHarness('ERR');
      await expect(service.reconcileStaleWxPay(payment.orderNo, { allowClose: false })).resolves.toEqual({
        orderNo: payment.orderNo,
        status: 'CREATED',
      });
      expect(tx.bill.updateMany).not.toHaveBeenCalled();
    });

    it('不传 options 时默认允许关单——管理端 force-sync 是人工动作，行为不能变', async () => {
      const { payment, close, service } = makeNotpayHarness('NOTPAY');
      await service.reconcileStaleWxPay(payment.orderNo);
      expect(close).toHaveBeenCalledWith(payment.orderNo);
    });

    it('SUCCESS 不受 allowClose 影响——入账永远要做', async () => {
      /*
       * 这条是整个修复的目的所在：allowClose:false 的年轻订单，
       * 若微信说已支付，必须立刻入账，不能被「不许写终态」误伤。
       */
      const payment = {
        id: 'payment-1',
        wxUserId: 'owner-1',
        orderNo: 'WY202608010001',
        totalAmount: { toString: () => '1.00' },
        channel: 'WXPAY',
        status: 'CREATED',
        transactionId: null,
        paymentBills: [{ billId: 'bill-1' }],
      };
      const tx = {
        payment: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({ userCouponId: null }),
        },
        userCoupon: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        // 入账会写一条 CONFIRMED 事件（同事务）——纯查单入账的订单原本时间线是空的
        paymentEvent: { create: jest.fn().mockResolvedValue({}) },
        receipt: { create: jest.fn().mockResolvedValue({}) },
      };
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue(payment) },
          $transaction: jest.fn(async (cb: (c: typeof tx) => unknown) => cb(tx)),
        },
      };
      const queryProvider = {
        createOrder: jest.fn(),
        close: jest.fn(),
        queryOrder: jest.fn().mockResolvedValue(transaction()),
      } as PaymentProvider;
      const service = makeService(prisma, queryProvider);
      await expect(
        service.reconcileStaleWxPay(payment.orderNo, { allowClose: false }),
      ).resolves.toEqual({ orderNo: payment.orderNo, status: 'SUCCESS' });
    });
  });

  describe('回调证据与不可变收据', () => {
    const paidBill = { billId: 'bill-1', bill: { title: '物业费', period: '2026-07', amount: { toString: () => '1.00' }, house: { displayName: 'p101', community: { name: '示例小区' } } } };

    function notifyTx() {
      return {
        paymentEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
        payment: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          // 退券已挪进事务（时序修正），关单路径会在事务内读订单上的券
          findUnique: jest.fn().mockResolvedValue({ userCouponId: null }),
        },
        userCoupon: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
    }

    it('notify-first：CREATED 订单经回调转 SUCCESS，写回调证据、wxpayNotifiedAt 与不可变收据快照', async () => {
      const payment = {
        id: 'payment-1', tenantId: 'tenant-1', communityId: 'community-1', orderNo: 'WY202607220001',
        totalAmount: { toString: () => '1.00' }, channel: 'WXPAY', status: 'CREATED', transactionId: null,
        wxpayNotifiedAt: null, paymentBills: [paidBill],
      };
      const tx = notifyTx();
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue(payment) },
          $transaction: jest.fn(async (cb: (client: typeof tx) => unknown) => cb(tx)),
        },
      };
      const service = makeService(prisma);

      await expect(service.handleWxPayNotification(transaction())).resolves.toEqual({
        orderNo: payment.orderNo, status: 'SUCCESS',
      });
      // 回调证据
      expect(tx.paymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ type: 'NOTIFIED', source: 'WXPAY_NOTIFY', paymentId: 'payment-1' }),
      }));
      // wxpayNotifiedAt 置位
      expect(tx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'payment-1', wxpayNotifiedAt: null },
        data: expect.objectContaining({ wxpayNotifiedAt: expect.any(Date) }),
      }));
      // 成功入账 + 收据快照（唯一收据号、不含付款人身份）
      const successCall = tx.payment.updateMany.mock.calls.find(
        ([arg]: [{ data: Record<string, unknown> }]) => arg.data.status === 'SUCCESS',
      );
      expect(successCall).toBeDefined();
      const successData = successCall![0].data as Record<string, unknown>;
      expect(successData.receiptNo).toBe('RCPT-WY202607220001');
      expect(successData.confirmedBy).toBe('WXPAY_NOTIFY');
      const snapshot = successData.receiptSnapshot as Record<string, unknown>;
      expect(snapshot.orderNo).toBe('WY202607220001');
      expect(JSON.stringify(snapshot)).not.toContain('openid');

      /*
       * 支付成功入账必须写审计，且与入账同事务。
       *
       * 这是整条资金链最核心的一步——钱真正到账、账单销账。而生产审计日志 73 条里
       * 有「业主下单」Payment/CREATE、「线下收款」Payment/PAY、「退款」Refund/REFUND
       * （含 SYSTEM 类型），唯独没有这一步：查一笔钱时审计链会从 CREATE 直接跳到
       * REFUND，中间「什么时候确认收到钱」是空的。
       * 「系统动作也写审计」本就是既有约定（退款终态、发票冲红都用 SYSTEM），
       * 所以这不是设计选择而是遗漏。
       */
      expect(audit.append).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'SYSTEM',
          action: 'PAY',
          resourceType: 'Payment',
          resourceId: 'payment-1',
          afterSummary: expect.objectContaining({
            orderNo: 'WY202607220001',
            transactionId: '420000000001',
            // 区分「微信推过来的」还是「我们查出来的」
            source: 'WXPAY_NOTIFY',
            billIds: ['bill-1'],
          }),
        }),
        // 第二个参数是事务客户端：审计与入账要么都成、要么都不成
        expect.anything(),
      );
    });

    it('query-first then notify：已 SUCCESS 仍记录回调证据与 wxpayNotifiedAt，不重复入账', async () => {
      const payment = {
        id: 'payment-1', tenantId: 'tenant-1', communityId: 'community-1', orderNo: 'WY202607220001',
        totalAmount: { toString: () => '1.00' }, channel: 'WXPAY', status: 'SUCCESS',
        transactionId: '420000000001', wxpayNotifiedAt: null, paymentBills: [paidBill],
      };
      const tx = notifyTx();
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue(payment) },
          $transaction: jest.fn(async (cb: (client: typeof tx) => unknown) => cb(tx)),
        },
      };
      const service = makeService(prisma);

      await expect(service.handleWxPayNotification(transaction())).resolves.toEqual({
        orderNo: payment.orderNo, status: 'SUCCESS',
      });
      expect(tx.paymentEvent.create).toHaveBeenCalled();
      // 仅证据事务；不再触发成功入账事务
      expect(prisma.raw.$transaction).toHaveBeenCalledTimes(1);
      const successCall = tx.payment.updateMany.mock.calls.find(
        ([arg]: [{ data: Record<string, unknown> }]) => arg.data.status === 'SUCCESS',
      );
      expect(successCall).toBeUndefined();
    });

    it('duplicate notify：重复回调不重复写证据', async () => {
      const payment = {
        id: 'payment-1', tenantId: 'tenant-1', communityId: 'community-1', orderNo: 'WY202607220001',
        totalAmount: { toString: () => '1.00' }, channel: 'WXPAY', status: 'SUCCESS',
        transactionId: '420000000001', wxpayNotifiedAt: new Date(), paymentBills: [paidBill],
      };
      const tx = notifyTx();
      tx.paymentEvent.findFirst.mockResolvedValue({ id: 'evt-1' });
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue(payment) },
          $transaction: jest.fn(async (cb: (client: typeof tx) => unknown) => cb(tx)),
        },
      };
      const service = makeService(prisma);

      await service.handleWxPayNotification(transaction());
      expect(tx.paymentEvent.create).not.toHaveBeenCalled();
    });

    it('transaction ID uniqueness：已成功但回调交易号不一致时拒绝', async () => {
      const payment = {
        id: 'payment-1', tenantId: 'tenant-1', communityId: 'community-1', orderNo: 'WY202607220001',
        totalAmount: { toString: () => '1.00' }, channel: 'WXPAY', status: 'SUCCESS',
        transactionId: '420000000001', wxpayNotifiedAt: null, paymentBills: [paidBill],
      };
      const tx = notifyTx();
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue(payment) },
          $transaction: jest.fn(async (cb: (client: typeof tx) => unknown) => cb(tx)),
        },
      };
      const service = makeService(prisma);

      await expect(
        service.handleWxPayNotification(transaction({ transaction_id: '999999' })),
      ).rejects.toThrow('交易号不一致');
    });

    it('非成功订单不返回收据快照', async () => {
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue({
            id: 'payment-1', wxUserId: 'owner-1', orderNo: 'WY1', totalAmount: '1.00', status: 'CREATED',
            channel: 'WXPAY', paidAt: null, createdAt: new Date(), receiptSnapshot: null,
            paymentBills: [{ bill: { title: '物业费', house: { displayName: 'p101', community: { name: '示例小区' } } } }],
          }) },
        },
      };
      const service = makeService(prisma);
      const res = await service.getPayment('owner-1', 'WY1');
      expect(res.receipt).toBeNull();
      expect(res.receiptVoid).toBe(false);
    });

    it('退款后的收据标记作废', async () => {
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue({
            id: 'payment-1', wxUserId: 'owner-1', orderNo: 'WY1', totalAmount: '1.00', status: 'REFUNDED',
            channel: 'WXPAY', paidAt: new Date(), createdAt: new Date(),
            receiptNo: 'RCPT-WY1', receiptSnapshot: { orderNo: 'WY1', receiptNo: 'RCPT-WY1' },
            paymentBills: [{ bill: { title: '物业费', house: { displayName: 'p101', community: { name: '示例小区' } } } }],
          }) },
        },
      };
      const service = makeService(prisma);
      const res = await service.getPayment('owner-1', 'WY1');
      expect(res.receipt).toMatchObject({ receiptNo: 'RCPT-WY1' });
      expect(res.receiptVoid).toBe(true);
    });
  });

  /**
   * quoteBill 的可用券列表必须与 consumeCouponInTx 的接受范围一致。
   *
   * 起因（后端改了前端没跟上，而且此前 quoteBill 完全没有测试）：
   * consumeCouponInTx 已拒绝把应付降到 0（微信不接受 0 元订单，那个错误会让订单卡进
   * PREPAY_UNKNOWN、账单被占用、券被消耗），但 quoteBill 仍把这类券返回给小程序，
   * 确认页于是显示「确认支付 ¥0.00」并让业主点下去，点了才被拒。
   *
   * 这里调用**真实的** quoteBill，而不是复刻它的过滤条件——复刻出来的判定改不动
   * 真实代码，起不到守卫作用（本会话已因此栽过三次）。
   */
  describe('quoteBill 可用券列表', () => {
    function quotePrisma(billYuan: string, coupons: Array<{ face: string; threshold?: string | null }>) {
      return {
        raw: {
          bill: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'bill-1',
              tenantId: 'tenant-1',
              communityId: 'community-1',
              houseId: 'house-1',
              title: '物业费',
              period: '2026-07',
              amount: { toString: () => billYuan },
              status: 'UNPAID',
              dueDate: new Date('2026-08-26T15:59:59.000Z'),
              house: { displayName: '1栋1单元101', community: { name: '金港城' } },
            }),
          },
          houseBinding: { findFirst: jest.fn().mockResolvedValue({ id: 'b1', status: 'ACTIVE' }) },
          paymentBill: { findFirst: jest.fn().mockResolvedValue(null) },
          userCoupon: {
            findMany: jest.fn().mockResolvedValue(
              coupons.map((c, i) => ({
                id: `uc-${i}`,
                status: 'UNUSED',
                coupon: {
                  name: `券${i}`,
                  enabled: true,
                  communityId: null,
                  faceValue: { toString: () => c.face },
                  threshold: c.threshold === undefined || c.threshold === null
                    ? null
                    : { toString: () => c.threshold as string },
                  validFrom: new Date(Date.now() - 86_400_000),
                  validTo: new Date(Date.now() + 86_400_000),
                },
              })),
            ),
          },
        },
      };
    }

    async function usableFaces(billYuan: string, coupons: Array<{ face: string; threshold?: string | null }>) {
      const prisma = quotePrisma(billYuan, coupons);
      const res = (await makeService(prisma).quoteBill('owner-1', 'bill-1')) as {
        usableCoupons?: Array<{ discount?: string; name?: string }>;
      };
      return (res.usableCoupons ?? []).map((c) => c.discount);
    }

    it('券面额覆盖账单全额时不进入可用列表（否则确认页会显示「确认支付 ¥0.00」）', async () => {
      expect(await usableFaces('10.00', [{ face: '10.00' }])).toEqual([]);
      expect(await usableFaces('1.00', [{ face: '10.00' }])).toEqual([]);
      expect(await usableFaces('2.50', [{ face: '2.50' }])).toEqual([]);
    });

    it('面额小于账单金额时正常进入列表', async () => {
      const faces = await usableFaces('10.00', [{ face: '9.99' }]);
      expect(faces).toHaveLength(1);
    });

    it('混合场景：只保留实付为正的那些', async () => {
      const faces = await usableFaces('10.00', [
        { face: '10.00' }, // 覆盖全额 → 剔除
        { face: '3.00' }, // 可用
        { face: '20.00' }, // 超过账单 → 剔除
      ]);
      expect(faces).toHaveLength(1);
    });

    it('不满门槛的券也不进入列表', async () => {
      expect(await usableFaces('50.00', [{ face: '10.00', threshold: '100.00' }])).toEqual([]);
      expect(await usableFaces('150.00', [{ face: '10.00', threshold: '100.00' }])).toHaveLength(1);
    });
  });
});
