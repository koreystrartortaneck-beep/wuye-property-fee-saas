import { StatsController } from './stats.controller';

/**
 * 收缴统计：汇总必须等于各小区之和。
 *
 * 按覆盖率查过来的（这个文件原本 36%）。缺陷：by-community 只遍历
 * community.findMany() 的结果，任何 communityId 匹配不上的分组（历史数据、
 * 小区被删、或曾写入过跨租户的 communityId）金额**静默消失**，
 * 而 summary 是把所有分组都算进去的 —— 两个数对不上，界面上没有任何解释。
 *
 * 「同一个量两处显示成两个数」这类问题最费口舌：物业先怀疑自己看错，
 * 再怀疑系统在乱算。本仓已经出过一次（收缴率两处不同）。
 */

type Group = {
  communityId: string;
  status: string;
  _sum: { amount: { toString(): string } | null };
  _count: { _all: number };
};

const g = (communityId: string, status: string, amount: string, count: number): Group => ({
  communityId,
  status,
  _sum: { amount: { toString: () => amount } },
  _count: { _all: count },
});

function makeCtrl(groups: Group[], communities: Array<{ id: string; name: string }>) {
  const prisma = {
    t: {
      bill: { groupBy: jest.fn(async () => groups) },
      community: { findMany: jest.fn(async () => communities) },
    },
  };
  return new StatsController(prisma as never);
}

describe('统计口径', () => {
  it('应收含退款中/已退款，已收不含——钱已经退回去了', async () => {
    /*
     * 退款后这张账单又变成「没收到钱」：应收仍要算它（业主还是欠这笔），
     * 已收不能算（钱退回去了）。若把 REFUNDED 也算进已收，收缴率会虚高。
     */
    const ctrl = makeCtrl(
      [g('c1', 'PAID', '100.00', 1), g('c1', 'REFUNDED', '50.00', 1), g('c1', 'UNPAID', '50.00', 1)],
      [{ id: 'c1', name: '一区' }],
    );
    const s = (await ctrl.summary({})) as Record<string, unknown>;
    expect(s.billAmount).toBe('200.00');
    expect(s.paidAmount).toBe('100.00');
    expect(s.rate).toBe(50);
  });

  it('无账单时收缴率是 0 而不是 NaN', async () => {
    // 除零若没处理，界面会显示「NaN%」
    const s = (await makeCtrl([], []).summary({})) as Record<string, unknown>;
    expect(s.rate).toBe(0);
    expect(s.billAmount).toBe('0.00');
  });

  it('金额一律是两位小数字符串——前端直接拿去显示', async () => {
    /*
     * 断言的是**格式契约**，不是浮点精度。
     *
     * 我第一版写的是「金额用分累加，不用浮点」，注入「改用浮点累加」却没被抓到。
     * 核实后确认那条断言站不住：输入都是两位小数，浮点累加的相对误差在 1e-16 量级，
     * 而 toFixed(2) 在 1e-3 上取舍 —— 现实规模下翻不过来。
     * 用分累加是意图更清楚（金额就该用整数分），但「不用分就会算错」在这里是假的，
     * 不能拿一条咬不动的断言充当保护。
     *
     * 真正会坏事的是格式：前端多处直接 `¥{{amount}}` 渲染，
     * 一旦这里返回 number 或 '0.3'，界面上就会出现「¥0.3」这种半截金额。
     */
    const ctrl = makeCtrl(
      [g('c1', 'PAID', '0.10', 1), g('c1', 'PAID', '0.20', 1), g('c1', 'UNPAID', '5.00', 1)],
      [{ id: 'c1', name: '一区' }],
    );
    const s = (await ctrl.summary({})) as Record<string, unknown>;
    expect(s.paidAmount).toBe('0.30');
    expect(s.billAmount).toBe('5.30');
    for (const k of ['billAmount', 'paidAmount']) {
      expect(typeof s[k]).toBe('string');
      expect(s[k] as string).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('各小区之和等于汇总——匹配不到小区的账单要单独列出', async () => {
    /*
     * 这是本轮修的缺陷：c-gone 这个小区已不存在（或曾写入过跨租户的 id），
     * 原实现直接把它的 30 元丢掉，于是明细加起来只有 170，而汇总是 200。
     */
    const groups = [
      g('c1', 'PAID', '100.00', 1),
      g('c2', 'UNPAID', '70.00', 1),
      g('c-gone', 'UNPAID', '30.00', 1),
    ];
    const communities = [
      { id: 'c1', name: '一区' },
      { id: 'c2', name: '二区' },
    ];
    const rows = (await makeCtrl(groups, communities).byCommunity({})) as Array<{ name: string; billAmount: string }>;
    const total = (await makeCtrl(groups, communities).summary({})) as Record<string, unknown>;

    const sumRows = rows.reduce((acc, r) => acc + Math.round(Number(r.billAmount) * 100), 0);
    expect(sumRows).toBe(Math.round(Number(total.billAmount as string) * 100));

    const orphan = rows.find((r) => r.name === '未归属小区');
    expect(orphan).toBeDefined();
    expect(orphan!.billAmount).toBe('30.00');
  });

  it('全部小区都能匹配上时不出现「未归属小区」这一行', async () => {
    // 正常情况下多出一行空数据会让物业以为系统有问题
    const rows = (await makeCtrl(
      [g('c1', 'PAID', '10.00', 1)],
      [{ id: 'c1', name: '一区' }],
    ).byCommunity({})) as Array<{ name: string; billAmount: string }>;
    expect(rows.map((r) => r.name)).toEqual(['一区']);
  });

  it('没有账单的小区也要出现在明细里（0 而不是缺行）', async () => {
    // 缺行会让物业以为漏了小区；显示 0 才是「这个小区本期没出账」
    const rows = (await makeCtrl(
      [g('c1', 'PAID', '10.00', 1)],
      [
        { id: 'c1', name: '一区' },
        { id: 'c2', name: '二区' },
      ],
    ).byCommunity({})) as Array<{ name: string; billAmount: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[1].billAmount).toBe('0.00');
  });

  it('已作废与未发布的账单不进统计', async () => {
    // 作废的不该算应收；未发布的业主还看不到，算进去会让收缴率无端变低
    const ctrl = makeCtrl([], []);
    await ctrl.summary({});
    const where = (ctrl as unknown as { prisma: { t: { bill: { groupBy: jest.Mock } } } }).prisma.t.bill
      .groupBy.mock.calls[0][0].where;
    expect(where.status).toEqual({ notIn: ['CANCELED', 'DRAFT'] });
  });
});
