import { PaymentService } from './payment.service';
import { PaymentProviderError, type PaymentProvider, type WxPayTransaction } from './provider';

describe('PaymentService 微信支付回调入账', () => {
  const provider = { createOrder: jest.fn(), close: jest.fn() } as PaymentProvider;

  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  it('事务内账单预占失败时不创建渠道订单', async () => {
    const bills = [{
      id: 'bill-1',
      tenantId: 'tenant-1',
      houseId: 'house-1',
      title: '物业费',
      amount: { toString: () => '1.00' },
      status: 'UNPAID',
    }];
    const tx = {
      payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1', orderNo: 'WY1' }) },
      bill: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      paymentBill: { createMany: jest.fn() },
    };
    const prisma = {
      raw: {
        bill: { findMany: jest.fn().mockResolvedValue(bills) },
        houseBinding: { findMany: jest.fn().mockResolvedValue([{ houseId: 'house-1' }]) },
        paymentBill: { findFirst: jest.fn().mockResolvedValue(null) },
        wxUser: { findUnique: jest.fn().mockResolvedValue({ openid: 'openid-1' }) },
        $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      },
    };
    const service = new PaymentService(prisma as never, provider);

    await expect(service.createPayment('owner-1', ['bill-1'])).rejects.toThrow('账单已被其他支付占用');
    expect(tx.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: 'tenant-1', wxUserId: 'owner-1' }),
    });
    expect(tx.bill.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['bill-1'] }, status: 'UNPAID', paymentId: null },
      data: { paymentId: 'payment-1' },
    });
    expect(provider.createOrder).not.toHaveBeenCalled();
  });

  it('Mock 模式也不能确认 WXPAY 渠道订单', async () => {
    const previousMode = process.env.PAY_MODE;
    const previousAllowMock = process.env.ALLOW_MOCK_PAYMENTS;
    process.env.PAY_MODE = 'mock';
    process.env.ALLOW_MOCK_PAYMENTS = 'true';
    const prisma = {
      raw: {
        payment: { findUnique: jest.fn().mockResolvedValue({
          id: 'payment-1',
          wxUserId: 'owner-1',
          channel: 'WXPAY',
          status: 'CREATED',
          paymentBills: [{ billId: 'bill-1' }],
        }) },
      },
    };
    const service = new PaymentService(prisma as never, provider);

    await expect(service.mockConfirm('owner-1', 'WY1')).rejects.toThrow('真实支付订单不可 mock 确认');
    process.env.PAY_MODE = previousMode;
    process.env.ALLOW_MOCK_PAYMENTS = previousAllowMock;
  });

  it('核对金额后原子更新订单与账单', async () => {
    const payment = {
      id: 'payment-1',
      orderNo: 'WY202607220001',
      totalAmount: { toString: () => '1.00' },
      channel: 'WXPAY',
      status: 'CREATED',
      transactionId: null,
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
    const service = new PaymentService(prisma as never, provider);

    await expect(service.handleWxPaySuccess(transaction())).resolves.toEqual({
      orderNo: payment.orderNo,
      status: 'SUCCESS',
    });
    expect(tx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: payment.id, status: 'CREATED' },
      data: expect.objectContaining({ status: 'SUCCESS', transactionId: '420000000001' }),
    }));
    expect(tx.bill.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['bill-1', 'bill-2'] }, status: 'UNPAID', paymentId: payment.id },
      data: expect.objectContaining({ status: 'PAID' }),
    }));
  });

  it('金额不一致时拒绝入账', async () => {
    const prisma = {
      raw: {
        payment: { findUnique: jest.fn().mockResolvedValue({
          id: 'payment-1',
          totalAmount: { toString: () => '2.00' },
          channel: 'WXPAY',
          status: 'CREATED',
          paymentBills: [{ billId: 'bill-1' }],
        }) },
        $transaction: jest.fn(),
      },
    };
    const service = new PaymentService(prisma as never, provider);

    await expect(service.handleWxPaySuccess(transaction())).rejects.toThrow('支付回调金额不一致');
    expect(prisma.raw.$transaction).not.toHaveBeenCalled();
  });

  it('同一微信交易号的重复回调幂等成功', async () => {
    const prisma = {
      raw: {
        payment: { findUnique: jest.fn().mockResolvedValue({
          id: 'payment-1',
          orderNo: 'WY202607220001',
          totalAmount: { toString: () => '1.00' },
          channel: 'WXPAY',
          status: 'SUCCESS',
          transactionId: '420000000001',
          paymentBills: [{ billId: 'bill-1' }],
        }) },
        $transaction: jest.fn(),
      },
    };
    const service = new PaymentService(prisma as never, provider);

    await expect(service.handleWxPaySuccess(transaction())).resolves.toEqual({
      orderNo: 'WY202607220001',
      status: 'SUCCESS',
    });
    expect(prisma.raw.$transaction).not.toHaveBeenCalled();
  });

  it('用户取消未支付订单时关单并释放账单预占', async () => {
    const payment = {
      id: 'payment-1',
      wxUserId: 'owner-1',
      orderNo: 'WY202607220001',
      channel: 'WXPAY',
      status: 'CREATED',
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
    const service = new PaymentService(prisma as never, queryProvider);

    await expect(service.cancelWxPay('owner-1', payment.orderNo)).resolves.toEqual({
      orderNo: payment.orderNo,
      status: 'CLOSED',
    });
    expect(queryProvider.close).toHaveBeenCalledWith(payment.orderNo);
    expect(tx.bill.updateMany).toHaveBeenCalledWith({
      where: { paymentId: payment.id, status: 'UNPAID' },
      data: { paymentId: null },
    });
  });

  it('超时订单在微信侧不存在时标记失败并释放账单', async () => {
    const payment = {
      id: 'payment-1',
      orderNo: 'WY202607220001',
      channel: 'WXPAY',
      status: 'CREATED',
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
      close: jest.fn(),
      queryOrder: jest.fn().mockRejectedValue(new PaymentProviderError(404, 'ORDER_NOT_EXIST', 'not found')),
    } as PaymentProvider;
    const service = new PaymentService(prisma as never, queryProvider);

    await expect(service.reconcileStaleWxPay(payment.orderNo)).resolves.toEqual({
      orderNo: payment.orderNo,
      status: 'FAILED',
    });
    expect(tx.bill.updateMany).toHaveBeenCalledWith({
      where: { paymentId: payment.id, status: 'UNPAID' },
      data: { paymentId: null },
    });
  });

  it('主动查单发现 SUCCESS 时走同一幂等入账逻辑', async () => {
    const payment = {
      id: 'payment-1',
      wxUserId: 'owner-1',
      orderNo: 'WY202607220001',
      totalAmount: { toString: () => '1.00' },
      channel: 'WXPAY',
      status: 'CREATED',
      transactionId: null,
      paymentBills: [{ billId: 'bill-1' }],
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
      close: jest.fn(),
      queryOrder: jest.fn().mockResolvedValue(transaction()),
    } as PaymentProvider;
    const service = new PaymentService(prisma as never, queryProvider);

    await expect(service.syncWxPay('owner-1', payment.orderNo)).resolves.toEqual({
      orderNo: payment.orderNo,
      status: 'SUCCESS',
    });
    expect(queryProvider.queryOrder).toHaveBeenCalledWith(payment.orderNo);
    expect(tx.payment.updateMany).toHaveBeenCalledTimes(1);
  });
});
