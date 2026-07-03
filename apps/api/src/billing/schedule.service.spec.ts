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
