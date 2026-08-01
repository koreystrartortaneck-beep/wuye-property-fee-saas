import { ErrorCode } from '@pf/shared';
import { assertTenantAccess } from '../audit/audit.service';
import { runWithTenant } from '../tenant/tenant-cls';
import { PaymentService } from './payment.service';
import type { PaymentProvider, WxPayTransaction } from './provider';

/**
 * 入账必须在订单所属租户的上下文里完成。
 *
 * ── 这是 2026-08-01 事故的真正根因 ──
 *
 * applyWxPaySuccess 的入账事务里要写一条 PAY 审计，而 audit.append 的第一句是
 * assertTenantAccess(tenantId)：没有租户上下文就抛 FORBIDDEN「缺少租户上下文」。
 * 微信回调没有登录态，定时兜底任务也没有 —— 两条系统路径都在这里抛错、
 * 整个入账事务回滚：
 *   · 回调：业主的钱扣了，订单留在 CREATED、账单留在 UNPAID，页面停在「入账中」
 *   · 兜底：每轮扫描抛同一个错，这条保底路径从未真正救回过任何一笔
 * 生产实测（订单 WY20260801018839）：回调 14:55:50 到达并验签通过，
 * 微信重试 4 次全部失败，失败原因正是「无权限访问：缺少租户上下文」。
 *
 * ── 为什么 140 个支付用例一个都没抓到 ──
 *
 * 因为它们都把审计服务模拟成 `{ append: jest.fn() }`。
 * 那个假实现没有租户断言，于是「缺少租户上下文」这件事在测试里根本不存在。
 * **模拟掉的正是会失败的那一句。**
 *
 * 所以本文件里的 audit 桩必须调用**真实的** assertTenantAccess ——
 * 这是这些用例唯一有意义的写法。
 */

const TXN = '4500000288202608012567221390';

function transaction(over: Partial<WxPayTransaction> = {}): WxPayTransaction {
  return {
    appid: 'wx-appid',
    mchid: '1900000109',
    out_trade_no: 'WY20260801018839',
    transaction_id: TXN,
    trade_state: 'SUCCESS',
    success_time: '2026-08-01T22:55:50+08:00',
    amount: { total: 2, currency: 'CNY' },
    ...over,
  };
}

function makeService(opts: { tenantId?: string } = {}) {
  const tenantId = opts.tenantId ?? 't-owner';
  const payment = {
    id: 'payment-1',
    wxUserId: 'owner-1',
    orderNo: 'WY20260801018839',
    totalAmount: { toString: () => '0.02' },
    channel: 'WXPAY',
    status: 'CREATED',
    transactionId: null,
    tenantId,
    communityId: 'c1',
    paymentBills: [{ billId: 'bill-1', bill: null }],
    wxpayNotifiedAt: null,
  };
  const tx = {
    payment: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ userCouponId: null }),
    },
    bill: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    userCoupon: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    paymentEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    raw: {
      payment: {
        findUnique: jest.fn(async (args: { select?: unknown }) =>
          args.select ? { status: 'SUCCESS', transactionId: TXN } : payment,
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      paymentEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(), upsert: jest.fn() },
      $transaction: jest.fn(async (cb: (c: typeof tx) => unknown) => cb(tx)),
    },
  };
  /*
   * 关键：这个桩调用真实的 assertTenantAccess。
   * 换成 jest.fn() 就退回成事故当时的测试形态 —— 什么都测不出来。
   */
  const append = jest.fn(async (input: { tenantId: string }) => {
    assertTenantAccess(input.tenantId);
    return {};
  });
  const provider = {
    createOrder: jest.fn(),
    close: jest.fn(),
    queryOrder: jest.fn().mockResolvedValue(transaction()),
  } as unknown as PaymentProvider;
  const service = new PaymentService(
    prisma as never,
    provider,
    { assertOpenForUpdate: jest.fn(), resolveEffectiveStatus: jest.fn() } as never,
    { reserve: jest.fn(), complete: jest.fn(), fail: jest.fn() } as never,
    { append } as never,
  );
  return { service, append, tx, tenantId };
}

describe('系统路径（无登录态）也必须能完成入账', () => {
  it('微信回调：没有租户上下文时照样入账成功', async () => {
    /*
     * 这一条就是事故本身。修复前它会抛「缺少租户上下文」。
     */
    const { service } = makeService();
    await expect(service.handleWxPayNotification(transaction())).resolves.toEqual({
      orderNo: 'WY20260801018839',
      status: 'SUCCESS',
    });
  });

  it('定时兜底：没有租户上下文时照样能查单入账', async () => {
    // closeStaleOrders → reconcileStaleWxPay → handleWxPaySuccess，同样没有登录态
    const { service } = makeService();
    await expect(service.reconcileStaleWxPay('WY20260801018839')).resolves.toMatchObject({
      status: 'SUCCESS',
    });
  });

  it('审计写入时上下文里是**订单所属**租户，不是空、也不是别人', async () => {
    /*
     * 只断言「不抛错」不够：把上下文设成 null 也能过 assertTenantAccess
     * （context.tenantId === null 时它放行，那是平台视角）。
     * 而入账写的是某一家公司的钱，上下文必须精确等于订单的租户。
     */
    const { service, append } = makeService({ tenantId: 't-gangcheng' });
    let seen: { set: boolean; tenantId: string | null } | null = null;
    append.mockImplementation(async (input: { tenantId: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      seen = (require('../tenant/tenant-cls') as typeof import('../tenant/tenant-cls')).getTenantContext();
      assertTenantAccess(input.tenantId);
      return {};
    });
    await service.handleWxPayNotification(transaction());
    expect(seen).toEqual({ set: true, tenantId: 't-gangcheng' });
  });

  it('已有上下文时不被覆盖成别的租户（管理员查单路径）', async () => {
    // 管理员在自己租户上下文里查单，落账仍应在订单租户内进行且两者一致
    const { service, append } = makeService({ tenantId: 't-gangcheng' });
    await expect(
      runWithTenant('t-gangcheng', () => service.reconcileStaleWxPay('WY20260801018839')),
    ).resolves.toMatchObject({ status: 'SUCCESS' });
    expect(append).toHaveBeenCalled();
  });
});

describe('跨租户防护要显式，不能靠审计断言顺带', () => {
  it('声明的期望租户与订单不符 → 按「找不到」拒绝', async () => {
    /*
     * 修复入账问题时已按订单租户建立上下文，于是原先由 audit.append 的
     * assertTenantAccess「顺带」拦住跨租户查单的那道防护消失了。
     * 订单号形如 WY+日期+6 位随机数，并非不可猜，必须显式拦。
     * 用 NOT_FOUND 而不是 FORBIDDEN：不向调用方确认这个订单号存在。
     */
    const { service } = makeService({ tenantId: 't-gangcheng' });
    await expect(
      service.reconcileStaleWxPay('WY20260801018839', { expectTenantId: 't-other' }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND.code });
  });

  it('相符时正常放行', async () => {
    const { service } = makeService({ tenantId: 't-gangcheng' });
    await expect(
      service.reconcileStaleWxPay('WY20260801018839', { expectTenantId: 't-gangcheng' }),
    ).resolves.toMatchObject({ status: 'SUCCESS' });
  });

  it('管理端接口必须把自己的租户传下来', () => {
    /*
     * 防护只有在调用方真的传了 expectTenantId 时才生效。
     * 忘记传不会报错、也不会有任何症状 —— 只是防护静默消失。
     */
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'admin-payment.controller.ts'),
      'utf8',
    ) as string;
    const i = src.indexOf("@Post(':orderNo/force-sync')");
    expect(i).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf('\n  }', i));
    expect(body).toMatch(/expectTenantId:\s*cur\.tenantId/);
  });
});
