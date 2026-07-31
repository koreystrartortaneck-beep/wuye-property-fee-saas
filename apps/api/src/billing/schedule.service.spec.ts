import { ScheduleService } from './schedule.service';

describe('ScheduleService：每日出账与催缴扫描（mock 依赖）', () => {
  const makeMocks = () => {
    const rules = [
      { id: 'r1', period: 'MONTHLY', billDay: 3, enabled: true },
      { id: 'r2', period: 'MONTHLY', billDay: 5, enabled: true },
      { id: 'r3', period: 'QUARTERLY', billDay: 3, enabled: true },
    ];
    const bills: unknown[] = [];
    const prisma = {
      raw: { tenant: { findMany: jest.fn().mockResolvedValue([{ id: 't1' }]) } },
      t: {
        feeRule: {
          findMany: jest.fn().mockImplementation(({ where }: { where: { billDay: number } }) =>
            Promise.resolve(rules.filter((r) => r.billDay === where.billDay)),
          ),
        },
        bill: { findMany: jest.fn().mockResolvedValue(bills) },
      },
    };
    const billRun = { generate: jest.fn().mockResolvedValue({ generated: 1, skipped: 0 }) };
    const notifier = { onBillCreated: jest.fn(), onReminder: jest.fn() };
    const svc = new ScheduleService(prisma as never, billRun as never, notifier as never);
    return { svc, prisma, billRun, notifier, bills };
  };

  it('2026-07-03：billDay=3 的 MONTHLY 与 QUARTERLY(7月锚点) 规则触发，billDay=5 不触发', async () => {
    const { svc, billRun } = makeMocks();
    await svc.runDailyBilling(new Date(2026, 6, 3));
    expect(billRun.generate).toHaveBeenCalledWith('r1', '2026-07');
    expect(billRun.generate).toHaveBeenCalledWith('r3', '2026-Q3');
    expect(billRun.generate).toHaveBeenCalledTimes(2);
  });

  it('2026-08-03：QUARTERLY 非锚点月不触发', async () => {
    const { svc, billRun } = makeMocks();
    await svc.runDailyBilling(new Date(2026, 7, 3));
    expect(billRun.generate).toHaveBeenCalledWith('r1', '2026-08');
    expect(billRun.generate).toHaveBeenCalledTimes(1);
  });

  it('单规则异常不阻断其余规则', async () => {
    const { svc, billRun } = makeMocks();
    billRun.generate.mockRejectedValueOnce(new Error('boom'));
    await expect(svc.runDailyBilling(new Date(2026, 6, 3))).resolves.not.toThrow();
    expect(billRun.generate).toHaveBeenCalledTimes(2);
  });

  it('催缴扫描：到期前3天与逾期分别通知', async () => {
    const { svc, prisma, notifier } = makeMocks();
    const now = new Date(2026, 6, 3, 9, 0, 0);
    const dueSoon = { id: 'b1', dueDate: new Date(2026, 6, 6, 12, 0, 0), status: 'UNPAID' };
    const overdue = { id: 'b2', dueDate: new Date(2026, 6, 1), status: 'UNPAID' };
    (prisma.t.bill.findMany as jest.Mock).mockImplementation(({ where }: { where: { dueDate: Record<string, Date> } }) => {
      if (where.dueDate.gte) return Promise.resolve([dueSoon]); // due-soon 窗口查询
      return Promise.resolve([overdue]); // 逾期查询
    });
    await svc.runReminders(now);
    expect(notifier.onReminder).toHaveBeenCalledWith(dueSoon, 'DUE_SOON');
    expect(notifier.onReminder).toHaveBeenCalledWith(overdue, 'OVERDUE');
  });
});

/**
 * 清理任务只能删「运行时中间态」，绝不能碰财务凭证与审计留痕。
 *
 * 这是全库唯一一个成规模删数据的地方，所以要用行为测试证明它删对了范围——
 * 静态断言（源码里有没有某张表）在这里不够：删错一张表的后果是不可逆的。
 */
describe('ScheduleService 清理过期运行时记录', () => {
  const DAY = 86_400_000;
  const now = new Date('2026-07-31T20:00:00.000Z');

  function makePrisma() {
    const del = (name: string) => jest.fn(async () => ({ count: 1, __table: name }));
    const raw: Record<string, { deleteMany: jest.Mock }> = {};
    for (const t of [
      'idempotencyRecord',
      'outboxEvent',
      'notifyLog',
      // 下面这些是财务凭证与审计留痕，一条都不该被删
      'payment',
      'refund',
      'bill',
      'invoiceApplication',
      'auditLog',
      'paymentEvent',
    ]) {
      raw[t] = { deleteMany: del(t) };
    }
    return { raw } as unknown as { raw: Record<string, { deleteMany: jest.Mock }> };
  }

  function makeService(prisma: unknown) {
    return new ScheduleService(prisma as never, {} as never, {} as never);
  }

  it('只删幂等记录、已投递事件、通知日志三张表', async () => {
    const prisma = makePrisma();
    await makeService(prisma).purgeExpired(now);

    for (const t of ['idempotencyRecord', 'outboxEvent', 'notifyLog']) {
      expect(prisma.raw[t].deleteMany).toHaveBeenCalledTimes(1);
    }
    // 财务凭证与审计一条都不能碰
    for (const t of ['payment', 'refund', 'bill', 'invoiceApplication', 'auditLog', 'paymentEvent']) {
      expect(prisma.raw[t].deleteMany).not.toHaveBeenCalled();
    }
  });

  it('幂等记录按 expiresAt 删（用上已有的索引），不按固定天数', async () => {
    const prisma = makePrisma();
    await makeService(prisma).purgeExpired(now);
    const where = prisma.raw.idempotencyRecord.deleteMany.mock.calls[0][0].where;
    expect(where).toEqual({ expiresAt: { lt: now } });
  });

  it('Outbox 只删已成功投递的（PENDING/FAILED 还要重试，PROCESSING 可能被别的实例持有）', async () => {
    const prisma = makePrisma();
    await makeService(prisma).purgeExpired(now);
    const where = prisma.raw.outboxEvent.deleteMany.mock.calls[0][0].where;
    expect(where.status).toBe('PUBLISHED');
    expect(where.publishedAt.lt.getTime()).toBe(now.getTime() - 90 * DAY);
  });

  it('通知日志保留 90 天', async () => {
    const prisma = makePrisma();
    await makeService(prisma).purgeExpired(now);
    const where = prisma.raw.notifyLog.deleteMany.mock.calls[0][0].where;
    expect(where.sentAt.lt.getTime()).toBe(now.getTime() - 90 * DAY);
  });

  it('某张表删除失败不抛出，业务不受影响', async () => {
    const prisma = makePrisma();
    prisma.raw.outboxEvent.deleteMany.mockRejectedValue(new Error('lock wait timeout'));
    await expect(makeService(prisma).purgeExpired(now)).resolves.toBeUndefined();
  });
});
