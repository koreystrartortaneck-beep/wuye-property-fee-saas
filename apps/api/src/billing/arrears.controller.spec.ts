import { ArrearsService } from './arrears.controller';

/**
 * 欠费清单是催缴的唯一依据：聚合金额、逾期天数、排序必须准确，
 * 且逾期要按北京时间的「日」判断（到期当天不算逾期）。
 */
describe('ArrearsService 欠费清单', () => {
  const DAY = 86_400_000;

  type FakeBill = {
    houseId: string;
    communityId: string;
    amount: { toString(): string };
    period: string;
    dueDate: Date;
    house: { code: string; displayName: string; ownerName: string; ownerPhone: string };
  };

  /*
   * 桩从账单行**推导** groupBy 的结果，而不是另喂一份聚合数据。
   *
   * 这样做的原因：list() 已改为把聚合下推到 SQL（原实现 findMany({take:5000}) 之后
   * 在 JS 里 reduce 求合计，3000 户小区单月就有 12000+ 张未缴账单，take 只拿到不足
   * 一半而 reduce 把它当全量——「本小区欠费 ¥X」直接算错且无任何截断提示）。
   * 如果桩里手写聚合结果，就等于绕过被测的分组逻辑；由账单推导才能同时覆盖
   * 「分组对不对」和「合计是不是全量」。
   */
  function makeService(bills: FakeBill[]) {
    const groupBy = jest.fn(async () => {
      const byHouse = new Map<string, { sum: number; count: number; min: Date }>();
      for (const b of bills) {
        const cents = Math.round(Number(b.amount.toString()) * 100);
        const cur = byHouse.get(b.houseId);
        if (!cur) byHouse.set(b.houseId, { sum: cents, count: 1, min: b.dueDate });
        else {
          cur.sum += cents;
          cur.count += 1;
          if (b.dueDate < cur.min) cur.min = b.dueDate;
        }
      }
      return [...byHouse.entries()].map(([houseId, v]) => ({
        houseId,
        _sum: { amount: { toString: () => (v.sum / 100).toFixed(2) } },
        _count: { _all: v.count },
        _min: { dueDate: v.min },
      }));
    });
    const houseFindMany = jest.fn(async (args: { where: { id: { in: string[] } } }) => {
      const ids = new Set(args.where.id.in);
      const seen = new Set<string>();
      const out: unknown[] = [];
      for (const b of bills) {
        if (!ids.has(b.houseId) || seen.has(b.houseId)) continue;
        seen.add(b.houseId);
        out.push({
          id: b.houseId,
          code: b.house.code,
          displayName: b.house.displayName,
          communityId: b.communityId,
          ownerName: b.house.ownerName,
          ownerPhone: b.house.ownerPhone,
        });
      }
      return out;
    });
    const billFindMany = jest.fn(async (args: { where: { houseId?: { in: string[] } } }) => {
      const ids = args.where.houseId ? new Set(args.where.houseId.in) : null;
      return bills
        .filter((b) => !ids || ids.has(b.houseId))
        .map((b) => ({ houseId: b.houseId, period: b.period }));
    });
    const prisma = {
      t: {
        bill: { groupBy, findMany: billFindMany },
        house: { findMany: houseFindMany },
      },
    };
    const idem = {} as never;
    return { service: new ArrearsService(prisma as never, idem), prisma, groupBy };
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
    const { service, groupBy } = makeService([]);
    await service.list({ communityId: 'c9' });
    // 聚合下推后，状态与小区过滤发生在 groupBy 上（原先在 findMany 上）
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['houseId'],
        where: expect.objectContaining({ status: 'UNPAID', communityId: 'c9' }),
      }),
    );
  });

  /*
   * 合计必须是全量真值，与明细是否截断无关。
   *
   * 这是本次修复的核心：原实现 findMany({ take: 5000 }) 之后用这 5000 行 reduce 求
   * totalAmount、用去重后的房屋数当 totalHouses。3000 户 × 4 条计费规则 = 单月
   * 12000 张未缴账单，于是收费员看到的「本小区欠费 ¥X」只有实际的四成多，且界面
   * 没有任何提示说数据被截断了。他会拿这个数字对账、导出报表。
   */
  it('明细截断时合计仍是全量：600 户 → 明细 500 条，合计 600 户全额', async () => {
    const many = [];
    for (let i = 0; i < 600; i += 1) {
      many.push(bill(`h${String(i).padStart(4, '0')}`, '100.00', '2026-08', -10));
    }
    const { service } = makeService(many);
    const res = await service.list({});
    expect(res.list.length).toBe(500);
    expect(res.truncated).toBe(true);
    // 600 × ¥100 = ¥60000，而不是 500 × ¥100
    expect(res.totalHouses).toBe(600);
    expect(res.totalAmount).toBe('60000.00');
    // 「其中已逾期」同样是全量：管理端原先用截断后的 rows 现算，会一起少报
    expect(res.overdueHouses).toBe(600);
  });

  it('未截断时 truncated 为 false', async () => {
    const { service } = makeService([bill('h1', '1.00', '2026-08', -1)]);
    const res = await service.list({});
    expect(res.truncated).toBe(false);
    expect(res.totalHouses).toBe(1);
  });

  it('逾期过滤后的合计也是真值（过滤发生在全量聚合结果上）', async () => {
    const { service } = makeService([
      bill('old', '100.00', '2026-06', -100),
      bill('fresh', '900.00', '2026-08', -1),
    ]);
    const res = await service.list({ overdueDays: 30 });
    expect(res.totalHouses).toBe(1);
    expect(res.totalAmount).toBe('100.00'); // 不含未达 30 天的那户
  });

  it('房屋信息与账期明细只为要返回的那几百户查，不是全量', async () => {
    const many = [];
    for (let i = 0; i < 600; i += 1) many.push(bill(`h${String(i).padStart(4, '0')}`, '100.00', '2026-08', -10));
    const { service, prisma } = makeService(many);
    await service.list({});
    const houseArgs = prisma.t.house.findMany.mock.calls[0][0] as { where: { id: { in: string[] } } };
    expect(houseArgs.where.id.in.length).toBe(500);
    const billArgs = prisma.t.bill.findMany.mock.calls[0][0] as { where: { houseId: { in: string[] } } };
    expect(billArgs.where.houseId.in.length).toBe(500);
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

  /*
   * 催缴已改为「排入 Outbox 队列」而不是请求内串行发送。
   *
   * 原实现循环账单逐笔 notifier.onReminder：500 户 × 4 条规则 × 约 1.5 个欠费账期
   * ≈ 3000 张账单，每张 1 次去重查询 + 1 次绑定查询 + 每人 1 次微信 HTTP + 1 次
   * 日志写入，全部串行 —— 约 9600 次数据库往返、3600 次微信调用、**720 秒**。
   * 网关早就切断了请求，而幂等记录停在 PROCESSING，管理端此后永远显示
   * 「催缴正在处理中，请稍候」，这个按钮再也点不动。
   *
   * 所以断言对象从 notifier.onReminder 换成落库的 eventType —— 那才是真正决定业主
   * 收到哪条文案的东西（notify.service 的 SUBSCRIBE_TEMPLATE_BY_EVENT 映射）。
   */
  function makeService(bills: unknown[]) {
    type OutboxRow = { aggregateId: string; eventType: string; dedupKey: string };
    const createMany = jest.fn(
      async (args: { data: OutboxRow[]; skipDuplicates?: boolean }) => ({ count: args.data.length }),
    );
    const prisma = {
      t: { bill: { findMany: jest.fn().mockResolvedValue(bills) } },
      raw: { outboxEvent: { createMany } },
    };
    const idempotency = {
      reserve: jest.fn().mockResolvedValue({ outcome: 'RESERVED', recordId: 'idem-1' }),
      complete: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    };
    const notifier = { onReminder: jest.fn().mockResolvedValue(undefined), onBillCreated: jest.fn() };
    return {
      service: new ArrearsService(prisma as never, idempotency as never, notifier as never),
      notifier,
      createMany,
    };
  }

  /** dueDate 存的是「到期那天上海 23:59:59」换算的 UTC 时刻 */
  function bill(id: string, dueInDays: number) {
    return {
      id,
      houseId: 'h1',
      communityId: 'c1',
      period: '2026-08',
      amount: { toString: () => '100.00' },
      dueDate: new Date(Date.now() + dueInDays * DAY),
    };
  }

  /** 取本次落库的事件（一次 createMany） */
  function eventsOf(createMany: jest.Mock): Array<{ aggregateId: string; eventType: string; dedupKey: string }> {
    expect(createMany).toHaveBeenCalledTimes(1);
    return createMany.mock.calls[0][0].data;
  }

  it('未到期的账单排 bill.due_soon，绝不能排 bill.overdue', async () => {
    const { service, createMany } = makeService([bill('b-future', 26)]);
    await service.dun('admin-1', 't1', { houseIds: ['h1'], requestId: 'r1' });

    const events = eventsOf(createMany);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ aggregateId: 'b-future', eventType: 'bill.due_soon' });
    expect(events.some((e) => e.eventType === 'bill.overdue')).toBe(false);
  });

  it('已过到期时刻的账单排 bill.overdue', async () => {
    const { service, createMany } = makeService([bill('b-past', -1)]);
    await service.dun('admin-1', 't1', { houseIds: ['h1'], requestId: 'r2' });
    expect(eventsOf(createMany)[0]).toMatchObject({ aggregateId: 'b-past', eventType: 'bill.overdue' });
  });

  it('同一批里逾期与未逾期各按自己的类型排', async () => {
    const { service, createMany } = makeService([bill('b-past', -3), bill('b-future', 10)]);
    await service.dun('admin-1', 't1', { houseIds: ['h1'], requestId: 'r3' });

    const byId = new Map(eventsOf(createMany).map((e) => [e.aggregateId, e.eventType]));
    expect(byId.get('b-past')).toBe('bill.overdue');
    expect(byId.get('b-future')).toBe('bill.due_soon');
  });

  it('一次批量写入，不在请求内逐笔发送', async () => {
    const many = [];
    for (let i = 0; i < 300; i += 1) many.push(bill(`b${i}`, -1));
    const { service, createMany, notifier } = makeService(many);
    const res = await service.dun('admin-1', 't1', { houseIds: ['h1'], requestId: 'r4' });

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(eventsOf(createMany)).toHaveLength(300);
    // 请求内绝不能再打微信：那是 720 秒超时的来源
    expect(notifier.onReminder).not.toHaveBeenCalled();
    expect(res.queued).toBe(300);
  });

  it('dedupKey 承接「每张账单每类提醒最多一次」，且用 skipDuplicates', async () => {
    const { service, createMany } = makeService([bill('b-1', -1)]);
    await service.dun('admin-1', 't1', { houseIds: ['h1'], requestId: 'r5' });
    const args = createMany.mock.calls[0][0] as {
      data: Array<{ dedupKey: string }>;
      skipDuplicates?: boolean;
    };
    expect(args.skipDuplicates).toBe(true);
    expect(args.data[0].dedupKey).toBe('bill.overdue:b-1');
  });

  it('撞 dedupKey 被跳过的计入 skipped，物业才知道有些没发出去', async () => {
    const { service, createMany } = makeService([bill('b-1', -1), bill('b-2', -1)]);
    // 模拟其中一条撞了已存在的 dedupKey
    createMany.mockResolvedValueOnce({ count: 1 });
    const res = await service.dun('admin-1', 't1', { houseIds: ['h1'], requestId: 'r6' });
    expect(res.queued).toBe(1);
    expect(res.skipped).toBe(1);
  });
});
