import { PaymentRecoveryService } from './payment-recovery.service';

/**
 * 这个定时任务是「业主付了钱但微信回调没到」时，钱能自动入账的唯一保底路径。
 *
 * 2026-08-01 真实事故：业主在小程序付款成功、微信已扣款，但账单一直是未缴，
 * 页面卡在「确认支付结果」。最终是人工调 force-sync 才入账的。
 * 复盘发现这个兜底本来该救回来，却慢得没意义：
 *   10 分钟一轮的扫描 × 只处理「已创建满 30 分钟」的订单 = 最坏 40 分钟
 * 而业主在扣款后 30 秒内就会开始怀疑自己被吞了钱。
 *
 * 慢的根因是**把「查单」和「关单」绑在同一个门槛上**：
 *   · 查单是只读的，早查只有好处（早入账）
 *   · 关单会作废订单并释放账单，业主若还在收银台输密码，关掉就是把他的支付作废
 * 于是为了「别误关单」而必须等的 30 分钟，把「早点让钱到账」也一起拖住了。
 *
 * 拆开之后：2 分钟起就查，30 分钟后才关。
 * 下面的测试钉住这个拆分 —— 它很容易在下一次重构里被合回一个常量。
 */

const NOW = new Date('2026-08-01T13:00:00Z');
/** 创建于 3 分钟前：该查单了，但远没到能关单的时候（业主可能还在输密码） */
const YOUNG = new Date(NOW.getTime() - 3 * 60 * 1000);
/** 创建于 45 分钟前：查也查、关也能关 */
const OLD = new Date(NOW.getTime() - 45 * 60 * 1000);

function makeService(
  rows: Array<Record<string, unknown>>,
  opts: { claim?: number; reconcile?: jest.Mock; alerts?: unknown } = {},
) {
  const findMany = jest.fn().mockResolvedValue(
    rows.map((r) => ({
      tenantId: 't1',
      communityId: 'c1',
      status: 'CREATED',
      lastSyncedAt: null,
      ...r,
    })),
  );
  const updateMany = jest.fn().mockResolvedValue({ count: opts.claim ?? 1 });
  const prisma = { raw: { payment: { findMany, updateMany } } };
  const payments = {
    reconcileStaleWxPay: opts.reconcile ?? jest.fn().mockResolvedValue({ status: 'CLOSED' }),
  };
  const service = new PaymentRecoveryService(
    prisma as never,
    payments as never,
    (opts.alerts ?? null) as never,
  );
  return { service, findMany, updateMany, reconcile: payments.reconcileStaleWxPay };
}

describe('PaymentRecoveryService', () => {
  const originalMode = process.env.PAY_MODE;

  beforeEach(() => {
    process.env.PAY_MODE = 'wxpay';
  });

  afterEach(() => {
    process.env.PAY_MODE = originalMode;
  });

  it('扫描超时的 CREATED 与 PREPAY_UNKNOWN 订单，逐笔以租约认领后处理且单笔失败不阻断', async () => {
    const reconcile = jest
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ status: 'CLOSED' });
    const { service, findMany, updateMany } = makeService(
      [
        { id: 'p1', orderNo: 'WY1', createdAt: OLD },
        {
          id: 'p2',
          orderNo: 'WY2',
          createdAt: OLD,
          lastSyncedAt: new Date(NOW.getTime() - 10 * 60 * 1000),
        },
      ],
      { reconcile },
    );

    await service.closeStaleOrders(NOW);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          channel: 'WXPAY',
          status: { in: ['CREATED', 'PREPAY_UNKNOWN'] },
        }),
      }),
    );
    // 多实例租约：认领时对每笔做乐观锁 updateMany
    expect(updateMany).toHaveBeenCalledTimes(2);
    // 第一笔抛错不能吃掉第二笔——否则一次网络抖动就让整批订单继续挂着
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('认领失败（已被其他实例抢占）时跳过该订单', async () => {
    const { service, reconcile } = makeService([{ id: 'p1', orderNo: 'WY1', createdAt: OLD }], {
      claim: 0,
    });
    await service.closeStaleOrders(NOW);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('非 wxpay 模式下完全不动（本地/演示环境没有商户号）', async () => {
    process.env.PAY_MODE = 'mock';
    const { service, findMany } = makeService([{ id: 'p1', orderNo: 'WY1', createdAt: OLD }]);
    await service.closeStaleOrders(NOW);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('早查单、晚关单', () => {
  const originalMode = process.env.PAY_MODE;
  beforeEach(() => {
    process.env.PAY_MODE = 'wxpay';
  });
  afterEach(() => {
    process.env.PAY_MODE = originalMode;
  });

  it('刚创建几分钟的订单也要查单，但不许关单', async () => {
    /*
     * 这是事故的正解：业主 3 分钟前付的款，微信那边已经是 SUCCESS，
     * 这一轮查单就该把钱入账 —— 不该因为「还没满 30 分钟」而不查。
     * 同时 allowClose 必须是 false：万一微信返回 NOTPAY，说明他还在收银台，
     * 关单会把他正在进行的支付作废。
     */
    const { service, reconcile } = makeService([
      { id: 'p1', orderNo: 'WY-young', createdAt: YOUNG },
    ]);
    await service.closeStaleOrders(NOW);
    expect(reconcile).toHaveBeenCalledWith('WY-young', { allowClose: false });
  });

  it('超过 30 分钟的订单才允许关单', async () => {
    const { service, reconcile } = makeService([{ id: 'p1', orderNo: 'WY-old', createdAt: OLD }]);
    await service.closeStaleOrders(NOW);
    expect(reconcile).toHaveBeenCalledWith('WY-old', { allowClose: true });
  });

  it('查单门槛必须远小于关单门槛——两者合并回一个常量时这条会红', async () => {
    /*
     * 只断言「传了 allowClose」不够：把 QUERY_AFTER 改回 30 分钟，
     * 上面那条「年轻订单也要查」会变成空转（年轻订单根本不会被 findMany 选中，
     * 而 mock 的 findMany 不管 where 一律返回，断言照样通过）。
     * 所以这里直接钉扫描窗口本身。
     */
    const { service, findMany } = makeService([]);
    await service.closeStaleOrders(NOW);
    const cutoff = findMany.mock.calls[0][0].where.createdAt.lt as Date;
    expect(NOW.getTime() - cutoff.getTime()).toBeLessThanOrEqual(5 * 60 * 1000);
    // 且 YOUNG 确实落在窗口内，上面那条才不是空转
    expect(YOUNG.getTime()).toBeLessThan(cutoff.getTime());
  });

  it('租约必须短于扫描周期，否则「早查」被租约拖回去', async () => {
    /*
     * 2 分钟一轮 + 5 分钟租约 = 一笔订单查过一次后要等 5 分钟才复查。
     * 业主付款那一刻订单可能还是 NOTPAY（正在输密码），这一次查单必然无果 ——
     * 复查间隔就是他实际多等的时长。
     */
    const { service, findMany } = makeService([]);
    await service.closeStaleOrders(NOW);
    const leaseCutoff = findMany.mock.calls[0][0].where.OR[1].lastSyncedAt.lt as Date;
    expect(NOW.getTime() - leaseCutoff.getTime()).toBeLessThanOrEqual(2 * 60 * 1000);
  });

  it('定时任务的频率也要跟上（10 分钟一轮时，只拆门槛也救不回来）', () => {
    /*
     * 事故里的 40 分钟是「10 分钟一轮 × 满 30 分钟」两个因素叠出来的。
     * 只改门槛不改频率，最坏仍要等一整轮扫描。
     */
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'payment-recovery.service.ts'),
      'utf8',
    );
    const m = /@Cron\('0 \*\/(\d+) \* \* \* \*'\)/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(2);
  });
});

describe('长期未裁决要告警', () => {
  const originalMode = process.env.PAY_MODE;
  beforeEach(() => {
    process.env.PAY_MODE = 'wxpay';
  });
  afterEach(() => {
    process.env.PAY_MODE = originalMode;
  });

  it('超过 2 小时仍未终态 → 发 STALE_PAYMENT 告警', async () => {
    const safeEmit = jest.fn();
    const { service } = makeService(
      [{ id: 'p1', orderNo: 'WY-stuck', createdAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000) }],
      { alerts: { safeEmit } },
    );
    await service.closeStaleOrders(NOW);
    expect(safeEmit).toHaveBeenCalledWith(
      expect.objectContaining({ alertType: 'STALE_PAYMENT', dedupKey: 'STALE_PAYMENT:WY-stuck' }),
    );
  });

  it('刚创建的订单不告警——2 分钟一轮会把这种告警刷成噪音', async () => {
    const safeEmit = jest.fn();
    const { service } = makeService([{ id: 'p1', orderNo: 'WY-young', createdAt: YOUNG }], {
      alerts: { safeEmit },
    });
    await service.closeStaleOrders(NOW);
    expect(safeEmit).not.toHaveBeenCalled();
  });
});
