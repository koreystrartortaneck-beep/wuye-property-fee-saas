import { PaymentService } from './payment.service';
import type { PaymentProvider, WxPayTransaction } from './provider';

/**
 * 2026-08-01「钱扣了、账单不变、全链路零痕迹」的根因守卫。
 *
 * 真实经过（生产数据核实）：
 *   12:37:40.737  业主下单
 *   12:37:45.346  微信回调到达、验签通过、NOTIFIED 事件落库、wxpayNotifiedAt 置值
 *   ……            订单仍是 CREATED，账单仍是 UNPAID，审计里没有 PAY
 *   13:19:34      人工调 force-sync 才真正入账（confirmedBy=WXPAY_QUERY）
 * 中间 42 分钟无人知晓：没有告警、没有失败事件、微信也不再重试。
 *
 * 根因是 applyWxPaySuccess 里这一行：
 *     if (updated.count === 0) return;      // 事务外照旧 return status:'SUCCESS'
 *
 * count=0 只说明「有人并发把状态挪出了可入账区间」，**不等于有人把它入账了**。
 * 并发的那一方完全可能在后续步骤抛错回滚，状态又回到 CREATED —— 于是两边都
 * 以为对方做了。而对微信回调来说，返回 SUCCESS 等于告诉它「已受理」，
 * 它就永不重试，这笔钱再也不会自己回来。
 *
 * 这个文件钉住修好后的行为。它是资金安全相关的，不能被任何重构悄悄合回去。
 */

const TXN = '4500000288202608012567221390';

function transaction(overrides: Partial<WxPayTransaction> = {}): WxPayTransaction {
  return {
    appid: 'wx-appid',
    mchid: '1900000109',
    out_trade_no: 'WY20260801844562',
    transaction_id: TXN,
    trade_state: 'SUCCESS',
    success_time: '2026-08-01T20:37:45+08:00',
    amount: { total: 100, currency: 'CNY' },
    ...overrides,
  };
}

/**
 * 构造一个「条件更新匹配 0 行」的场景。
 * freshStatus / freshTxn 表示事务结束后重读到的真实状态。
 */
function makeService(opts: { freshStatus?: string; freshTxn?: string | null; freshMissing?: boolean }) {
  const payment = {
    id: 'payment-1',
    wxUserId: 'owner-1',
    orderNo: 'WY20260801844562',
    totalAmount: { toString: () => '1.00' },
    channel: 'WXPAY',
    status: 'CREATED',
    transactionId: null,
    tenantId: 't1',
    communityId: 'c1',
    paymentBills: [{ billId: 'bill-1', bill: null }],
  };
  const tx = {
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), findUnique: jest.fn() },
    bill: { updateMany: jest.fn() },
    userCoupon: { updateMany: jest.fn() },
    paymentEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
  };
  /*
   * findUnique 按参数分流，而不是按调用顺序：
   * 第一次读是带 include 的整行，事务后的复核读是带 select 的两列。
   * 用 mockResolvedValueOnce 排队的写法在实现里多加一次读就会错位，
   * 而错位后测试仍然「通过」——那是最坏的情况。
   */
  const findUnique = jest.fn(
    async (args: { select?: unknown }): Promise<Record<string, unknown> | null> =>
      args.select
        ? opts.freshMissing
          ? null
          : { status: opts.freshStatus, transactionId: opts.freshTxn ?? null }
        : payment,
  );
  const prisma = {
    raw: {
      payment: { findUnique, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      paymentEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(async (cb: (c: typeof tx) => unknown) => cb(tx)),
    },
  };
  const provider = { createOrder: jest.fn(), close: jest.fn() } as unknown as PaymentProvider;
  const service = new PaymentService(
    prisma as never,
    provider,
    { assertOpenForUpdate: jest.fn(), resolveEffectiveStatus: jest.fn() } as never,
    { reserve: jest.fn(), complete: jest.fn(), fail: jest.fn() } as never,
    { append: jest.fn() } as never,
      { autoGrantOnPayment: jest.fn(async () => undefined) } as never,
    );
  return { service, prisma, tx, findUnique };
}

describe('入账被并发跳过时绝不能报成功', () => {
  it('并发方其实没入账（状态仍是 CREATED）→ 抛错，让微信重试', async () => {
    /*
     * 这就是事故的那一刻。原代码在这里返回 SUCCESS，微信收到 200 后永不重试。
     * 现在必须抛错：非 2xx 会让微信按退避重试，是这笔钱能自己回来的主要途径。
     */
    const { service } = makeService({ freshStatus: 'CREATED' });
    await expect(service.handleWxPaySuccess(transaction())).rejects.toThrow(/并发跳过且未真正成功/);
  });

  it('错误信息要带订单号和当前状态——否则日志里认不出是哪一笔', async () => {
    const { service } = makeService({ freshStatus: 'CREATED' });
    await expect(service.handleWxPaySuccess(transaction())).rejects.toThrow(/WY20260801844562/);
    await expect(service.handleWxPaySuccess(transaction())).rejects.toThrow(/CREATED/);
  });

  it('复核时订单已经不存在了 → 同样抛错，不能当成成功', async () => {
    const { service } = makeService({ freshMissing: true });
    await expect(service.handleWxPaySuccess(transaction())).rejects.toThrow(/不存在/);
  });

  it('并发方确实入账成功且交易号一致 → 才算真正幂等，返回成功', async () => {
    /*
     * 这一支是必须保留的：微信会重复推同一笔回调，重复到达时不能报错，
     * 否则微信会一直重试一笔已经好了的订单。
     */
    const { service } = makeService({ freshStatus: 'SUCCESS', freshTxn: TXN });
    await expect(service.handleWxPaySuccess(transaction())).resolves.toEqual({
      orderNo: 'WY20260801844562',
      status: 'SUCCESS',
    });
  });

  it('状态是 SUCCESS 但交易号不是这一笔 → 抛错，不能默认幂等', async () => {
    /*
     * 交易号不同说明这笔订单被别的微信交易入账了，是需要人工核对的异常，
     * 不是重复回调。当成幂等会把一笔真实的资金差异抹掉。
     */
    const { service } = makeService({ freshStatus: 'SUCCESS', freshTxn: '4500000000000000000000000000' });
    await expect(service.handleWxPaySuccess(transaction())).rejects.toThrow(/并发跳过且未真正成功/);
  });

  it('复核读必须在事务之外——事务内的读在 REPEATABLE READ 下可能是旧快照', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'payment.service.ts'),
      'utf8',
    ) as string;
    const body = src.slice(src.indexOf('private async applyWxPaySuccess'), src.indexOf('private receiptInclude'));
    const txEnd = body.indexOf('});', body.indexOf('await this.prisma.raw.$transaction'));
    const afterTx = body.slice(txEnd);
    expect(afterTx).toContain('skippedByConcurrentUpdate');
    expect(afterTx).toMatch(/this\.prisma\.raw\.payment\.findUnique/);
  });
});
