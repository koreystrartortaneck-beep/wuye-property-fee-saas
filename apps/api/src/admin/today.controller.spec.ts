import { TodayService } from './today.controller';

/**
 * 「今天」页要直接告诉用户当前该干什么，所以 phase 判断与待办聚合是核心逻辑。
 */
describe('TodayService 今日概览', () => {
  const DAY = 86_400_000;
  function amt(v: string) {
    return { toString: () => v };
  }

  /** 把未缴账单按 houseId 聚合；overdueOnly 时只算已过到期时刻的 */
  function groupByHouse(
    bills: unknown[],
    overdueOnly: boolean,
  ): Array<{ houseId: string; _sum: { amount: { toString(): string } } }> {
    const now = Date.now();
    const byHouse = new Map<string, number>();
    for (const b of bills as Array<{ amount: { toString(): string }; dueDate?: Date; houseId: string }>) {
      if (overdueOnly && !(b.dueDate && b.dueDate.getTime() < now)) continue;
      const cents = Math.round(Number(b.amount.toString()) * 100);
      byHouse.set(b.houseId, (byHouse.get(b.houseId) ?? 0) + cents);
    }
    return [...byHouse.entries()].map(([houseId, cents]) => ({
      houseId,
      _sum: { amount: amt((cents / 100).toFixed(2)) },
    }));
  }

  /** counts 顺序：绑定/工单/开票/红冲/对账差异/草稿批次/待确认支付 */
  function makePrisma(
    counts: number[],
    periodBills: unknown[] = [],
    unpaidBills: unknown[] = [],
  ) {
    const [b, t, i, r, rc, db, sp] = counts;
    return {
      t: {
        houseBinding: { count: jest.fn().mockResolvedValue(b) },
        ticket: { count: jest.fn().mockResolvedValue(t) },
        invoiceApplication: {
          count: jest
            .fn()
            .mockImplementationOnce(() => Promise.resolve(i))
            .mockImplementationOnce(() => Promise.resolve(r)),
        },
        reconciliationItem: { count: jest.fn().mockResolvedValue(rc) },
        billBatch: { count: jest.fn().mockResolvedValue(db) },
        payment: { count: jest.fn().mockResolvedValue(sp) },
        /*
         * 三次 groupBy 的结果由账单行**推导**，而不是手写聚合数据——手写等于绕过
         * 被测的分组与累加逻辑（本会话已因「复刻式守卫」栽过多次）。
         *
         * 顺序与 overview() 里 Promise.all 的顺序一致：
         *   ① 本月账单按 status 分组（收缴进度）
         *   ② 全账期未缴按 houseId 分组（欠费金额 + 欠费户数）
         *   ③ 同上但只含已过到期时刻的（逾期金额 + 逾期户数）
         */
        bill: {
          groupBy: jest
            .fn()
            // ① 本月账单按 status
            .mockImplementationOnce(() => {
              const byStatus = new Map<string, { cents: number; count: number }>();
              for (const b of periodBills as Array<{ amount: { toString(): string }; status: string }>) {
                const cents = Math.round(Number(b.amount.toString()) * 100);
                const cur = byStatus.get(b.status) ?? { cents: 0, count: 0 };
                cur.cents += cents;
                cur.count += 1;
                byStatus.set(b.status, cur);
              }
              return Promise.resolve(
                [...byStatus.entries()].map(([status, v]) => ({
                  status,
                  _sum: { amount: amt((v.cents / 100).toFixed(2)) },
                  _count: { _all: v.count },
                })),
              );
            })
            // ② 未缴按 houseId
            .mockImplementationOnce(() => Promise.resolve(groupByHouse(unpaidBills, false)))
            // ③ 已逾期未缴按 houseId
            .mockImplementationOnce(() => Promise.resolve(groupByHouse(unpaidBills, true))),
        },
      },
    };
  }

  it('本月无账单且无草稿 → 建议先出账', async () => {
    const s = new TodayService(makePrisma([0, 0, 0, 0, 0, 0, 0]) as never);
    const res = await s.overview({});
    expect(res.phase).toBe('NEED_BILLING');
    expect(res.todoTotal).toBe(0);
  });

  it('有草稿批次 → 建议去发布（优先于催缴）', async () => {
    const s = new TodayService(
      makePrisma([0, 0, 0, 0, 0, 1, 0], [{ amount: amt('100.00'), status: 'UNPAID' }], [
        { amount: amt('100.00'), dueDate: new Date(Date.now() - DAY), houseId: 'h1' },
      ]) as never,
    );
    const res = await s.overview({});
    expect(res.phase).toBe('NEED_PUBLISH');
    expect(res.todos.find((t) => t.key === 'draftBatch')?.count).toBe(1);
  });

  it('已发布且有欠费 → 进入催缴阶段，欠费与逾期分别统计', async () => {
    const s = new TodayService(
      makePrisma(
        [0, 0, 0, 0, 0, 0, 0],
        [
          { amount: amt('200.00'), status: 'PAID' },
          { amount: amt('300.00'), status: 'UNPAID' },
        ],
        [
          { amount: amt('300.00'), dueDate: new Date(Date.now() - 10 * DAY), houseId: 'h1' },
          { amount: amt('100.00'), dueDate: new Date(Date.now() + 10 * DAY), houseId: 'h2' },
        ],
      ) as never,
    );
    const res = await s.overview({});
    expect(res.phase).toBe('DUNNING');
    expect(res.collection.rate).toBe(40); // 200 / 500
    expect(res.arrears.amount).toBe('400.00');
    expect(res.arrears.houses).toBe(2);
    expect(res.arrears.overdueAmount).toBe('300.00');
    expect(res.arrears.overdueHouses).toBe(1);
  });

  it('无欠费但有对账差异 → 进入对账阶段', async () => {
    const s = new TodayService(
      makePrisma([0, 0, 0, 0, 2, 0, 0], [{ amount: amt('100.00'), status: 'PAID' }], []) as never,
    );
    const res = await s.overview({});
    expect(res.phase).toBe('RECONCILE');
    expect(res.collection.rate).toBe(100);
  });

  it('全部清零 → CLEAR', async () => {
    const s = new TodayService(
      makePrisma([0, 0, 0, 0, 0, 0, 0], [{ amount: amt('100.00'), status: 'PAID' }], []) as never,
    );
    expect((await s.overview({})).phase).toBe('CLEAR');
  });

  it('待办只列出计数大于 0 的项，并给出跳转目标', async () => {
    const s = new TodayService(makePrisma([3, 2, 1, 4, 0, 0, 5]) as never);
    const res = await s.overview({});
    expect(res.todos.map((t) => t.key)).toEqual([
      'bindings',
      'tickets',
      'invoices',
      'reversal',
      'stuckPayment',
    ]);
    expect(res.todoTotal).toBe(15);
    expect(res.todos.every((t) => !!t.to)).toBe(true);
  });

  it('无账单时收缴率为 0 而非除零 NaN', async () => {
    const s = new TodayService(makePrisma([0, 0, 0, 0, 0, 0, 0]) as never);
    expect((await s.overview({})).collection.rate).toBe(0);
  });
});
