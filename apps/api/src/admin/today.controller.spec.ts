import { TodayService } from './today.controller';

/**
 * 「今天」页要直接告诉用户当前该干什么，所以 phase 判断与待办聚合是核心逻辑。
 */
describe('TodayService 今日概览', () => {
  const DAY = 86_400_000;
  function amt(v: string) {
    return { toString: () => v };
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
        bill: {
          findMany: jest
            .fn()
            .mockImplementationOnce(() => Promise.resolve(periodBills))
            .mockImplementationOnce(() => Promise.resolve(unpaidBills)),
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
