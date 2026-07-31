import { ArrearsService } from './arrears.controller';

/**
 * 欠费清单是催缴的唯一依据：聚合金额、逾期天数、排序必须准确，
 * 且逾期要按北京时间的「日」判断（到期当天不算逾期）。
 */
describe('ArrearsService 欠费清单', () => {
  const DAY = 86_400_000;

  function makeService(bills: unknown[]) {
    const prisma = { t: { bill: { findMany: jest.fn().mockResolvedValue(bills) } } };
    const idem = {} as never;
    return { service: new ArrearsService(prisma as never, idem), prisma };
  }

  /** 构造「距今 n 天到期」的账单（负数=已过期 n 天） */
  function bill(houseId: string, amount: string, period: string, dueInDays: number) {
    return {
      houseId,
      communityId: 'c1',
      amount: { toString: () => amount },
      period,
      dueDate: new Date(Date.now() + dueInDays * DAY),
      house: { code: houseId, displayName: `房屋${houseId}`, ownerName: '张三', ownerPhone: '13800138000' },
    };
  }

  it('按住户聚合金额与笔数，账期去重并排序', async () => {
    const { service } = makeService([
      bill('h1', '222.50', '2026-08', -10),
      bill('h1', '222.50', '2026-07', -40),
      bill('h2', '100.00', '2026-08', -10),
    ]);
    const res = await service.list({});
    expect(res.totalHouses).toBe(2);
    expect(res.totalAmount).toBe('545.00');
    const h1 = res.list.find((r) => r.houseId === 'h1')!;
    expect(h1.unpaidCount).toBe(2);
    expect(h1.unpaidAmount).toBe('445.00');
    expect(h1.periods).toEqual(['2026-07', '2026-08']);
  });

  it('逾期天数取最早一笔；未到期为 0（到期当天不算逾期）', async () => {
    const { service } = makeService([
      bill('h1', '100.00', '2026-07', -40),
      bill('h1', '100.00', '2026-08', -1),
      bill('h2', '100.00', '2026-09', 5),
    ]);
    const res = await service.list({});
    const h1 = res.list.find((r) => r.houseId === 'h1')!;
    const h2 = res.list.find((r) => r.houseId === 'h2')!;
    expect(h1.overdueDays).toBeGreaterThanOrEqual(39);
    expect(h2.overdueDays).toBe(0);
  });

  it('默认按欠费金额倒序；sort=days 时按逾期天数倒序', async () => {
    const { service } = makeService([
      bill('small', '10.00', '2026-07', -100),
      bill('big', '999.00', '2026-08', -1),
    ]);
    expect((await service.list({})).list[0].houseId).toBe('big');
    expect((await service.list({ sort: 'days' })).list[0].houseId).toBe('small');
  });

  it('overdueDays 过滤只保留逾期达标的住户', async () => {
    const { service } = makeService([
      bill('old', '100.00', '2026-06', -60),
      bill('new', '100.00', '2026-09', -2),
    ]);
    const res = await service.list({ overdueDays: 30 });
    expect(res.list.map((r) => r.houseId)).toEqual(['old']);
    expect(res.totalHouses).toBe(1);
  });

  it('只统计 UNPAID（查询条件写死，避免把已缴/作废算进欠费）', async () => {
    const { service, prisma } = makeService([]);
    await service.list({ communityId: 'c9' });
    expect(prisma.t.bill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'UNPAID', communityId: 'c9' }) }),
    );
  });
});

/**
 * 催缴通知类型必须按账单实际是否逾期来选。
 *
 * 线上实测（业主手机截图）：给一张 2026-08-26 到期的账单发催缴，业主 7 月 31 日
 * 就收到「已逾期，请尽快处理」——离到期还有 26 天。原实现无条件发 OVERDUE，
 * 这是直接对业主说假话，会引发投诉。
 */
describe('ArrearsService 催缴通知类型', () => {
  const DAY = 86_400_000;

  function makeService(bills: unknown[]) {
    const prisma = { t: { bill: { findMany: jest.fn().mockResolvedValue(bills) } } };
    const idempotency = {
      reserve: jest.fn().mockResolvedValue({ outcome: 'RESERVED', recordId: 'idem-1' }),
      complete: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    };
    const notifier = { onReminder: jest.fn().mockResolvedValue(undefined), onBillCreated: jest.fn() };
    return {
      service: new ArrearsService(prisma as never, idempotency as never, notifier as never),
      notifier,
    };
  }

  /** dueDate 存的是「到期那天上海 23:59:59」换算的 UTC 时刻 */
  function bill(id: string, dueInDays: number) {
    return { id, houseId: 'h1', dueDate: new Date(Date.now() + dueInDays * DAY) };
  }

  it('未到期的账单发 DUE_SOON，绝不能发 OVERDUE', async () => {
    const { service, notifier } = makeService([bill('b-future', 26)]);
    await service.dun('admin-1', 't1', { houseIds: ['h1'], requestId: 'r1' });

    expect(notifier.onReminder).toHaveBeenCalledWith(expect.objectContaining({ id: 'b-future' }), 'DUE_SOON');
    expect(notifier.onReminder).not.toHaveBeenCalledWith(expect.anything(), 'OVERDUE');
  });

  it('已过到期时刻的账单发 OVERDUE', async () => {
    const { service, notifier } = makeService([bill('b-past', -1)]);
    await service.dun('admin-1', 't1', { houseIds: ['h1'], requestId: 'r2' });

    expect(notifier.onReminder).toHaveBeenCalledWith(expect.objectContaining({ id: 'b-past' }), 'OVERDUE');
  });

  it('同一批里逾期与未逾期各按自己的类型发', async () => {
    const { service, notifier } = makeService([bill('b-past', -3), bill('b-future', 10)]);
    await service.dun('admin-1', 't1', { houseIds: ['h1'], requestId: 'r3' });

    expect(notifier.onReminder).toHaveBeenCalledWith(expect.objectContaining({ id: 'b-past' }), 'OVERDUE');
    expect(notifier.onReminder).toHaveBeenCalledWith(expect.objectContaining({ id: 'b-future' }), 'DUE_SOON');
  });
});
