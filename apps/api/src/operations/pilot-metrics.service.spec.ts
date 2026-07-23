import { PilotMetricsService } from './pilot-metrics.service';

describe('PilotMetricsService 灰度指标', () => {
  function makePrisma(counts: Record<string, number>, groups: any[] = [], daily: any[] = []) {
    return {
      t: {
        payment: {
          count: jest.fn(async ({ where }: any) => {
            if (where.status === 'SUCCESS') return counts.paySuccess ?? 0;
            if (where.status && where.status.in && where.status.in.includes('FAILED')) return counts.payFailed ?? 0;
            if (where.status === 'PREPAY_UNKNOWN') return counts.prepayUnknown ?? 0;
            return 0;
          }),
          groupBy: jest.fn(async () => groups),
        },
        refund: {
          count: jest.fn(async ({ where }: any) => {
            if (where.status === 'SUCCESS') return counts.refundSuccess ?? 0;
            if (where.status === 'ABNORMAL') return counts.refundAbnormal ?? 0;
            if (where.status && where.status.in) return counts.refundTerminal ?? 0;
            return 0;
          }),
        },
        reconciliationItem: { count: jest.fn(async () => counts.unresolvedRecon ?? 0) },
        incident: { count: jest.fn(async () => counts.severeIncidents ?? 0) },
      },
      raw: { $queryRaw: jest.fn(async () => daily) },
    };
  }

  const now = new Date('2026-07-22T00:00:00.000Z');
  const make = (prisma: any) => new PilotMetricsService(prisma as never);

  it('计算30日支付技术成功率（分子/分母显式）', async () => {
    const prisma = makePrisma({ paySuccess: 199, payFailed: 1 });
    const m = await make(prisma).metrics({ tenantId: 't1', now });
    expect(m.paymentTechnicalSuccessRate.numerator).toBe(199);
    expect(m.paymentTechnicalSuccessRate.denominator).toBe(200);
    expect(m.paymentTechnicalSuccessRate.rate).toBeCloseTo(0.995, 3);
    expect(m.paymentTechnicalSuccessRate.pass).toBe(true);
  });

  it('重复扣款计数来自成功支付按账单分组', async () => {
    const prisma = makePrisma({}, [
      { billId: 'b1', _count: { _all: 2 } },
      { billId: 'b2', _count: { _all: 1 } },
      { billId: 'b3', _count: { _all: 3 } },
    ]);
    const m = await make(prisma).metrics({ tenantId: 't1', now });
    expect(m.duplicateChargeCount.value).toBe(2);
    expect(m.duplicateChargeCount.pass).toBe(false);
  });

  it('未处置对账差异、退款完成率、严重事件、资损指标', async () => {
    const prisma = makePrisma({
      refundSuccess: 9,
      refundTerminal: 10,
      refundAbnormal: 1,
      unresolvedRecon: 2,
      severeIncidents: 1,
    });
    const m = await make(prisma).metrics({ tenantId: 't1', now });
    expect(m.unresolvedReconciliationDifferences.value).toBe(2);
    expect(m.refundCompletionRate.numerator).toBe(9);
    expect(m.refundCompletionRate.denominator).toBe(10);
    expect(m.refundCompletionRate.rate).toBeCloseTo(0.9, 3);
    expect(m.severeIncidentCount.value).toBe(1);
    // 资损指标：存在重复扣款/异常退款/未处置对账差异任一即为真
    expect(m.moneyLossIndicator.value).toBe(true);
    expect(m.overallPass).toBe(false);
  });

  it('返回按日明细', async () => {
    const prisma = makePrisma({ paySuccess: 1, payFailed: 0 }, [], [
      { day: '2026-07-21', success: 3, total: 3 },
      { day: '2026-07-22', success: 2, total: 2 },
    ]);
    const m = await make(prisma).metrics({ tenantId: 't1', now });
    expect(Array.isArray(m.daily)).toBe(true);
    expect(m.daily).toHaveLength(2);
  });

  it('全部达标时 overallPass 为真', async () => {
    const prisma = makePrisma({
      paySuccess: 200,
      payFailed: 0,
      refundSuccess: 5,
      refundTerminal: 5,
      unresolvedRecon: 0,
      severeIncidents: 0,
    });
    const m = await make(prisma).metrics({ tenantId: 't1', now });
    expect(m.overallPass).toBe(true);
  });
});
