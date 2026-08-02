import { PilotMetricsService } from './pilot-metrics.service';

describe('PilotMetricsService 灰度指标', () => {
  function makePrisma(counts: Record<string, number>, groups: any[] = [], daily: any[] = []) {
    return {
      t: {
        payment: {
          count: jest.fn(async ({ where }: any) => {
            /*
             * 成功的口径是 ['SUCCESS','REFUNDED'] —— 一笔支付被退款之后
             * 状态变成 REFUNDED，但它当时确实成功过。只数 SUCCESS 会让它
             * 从分子分母同时消失（生产实测：当天 4 笔成功支付全退款后，
             * 日报表显示 0/0）。
             */
            const inList = where.status?.in;
            if (inList?.includes('REFUNDED') && inList?.includes('SUCCESS')) return counts.paySuccess ?? 0;
            if (inList?.includes('FAILED')) return counts.payFailed ?? 0;
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
      raw: {
        $queryRaw: jest.fn(async () => daily),
        /*
         * Outbox 与通知健康度：此前完全没有监控覆盖，事件重试耗尽后永久沉在库里，
         * 业主该收到的账单/催缴无声无息地丢，后台任何页面都看不出异常。
         * 「积压」按 availableAt 是否为终态哨兵区分，两者不能混。
         */
        outboxEvent: {
          // 「已放弃」查询用 OR（终态哨兵 或 超次数），「积压」查询用 attempts < MAX
          count: jest.fn(async ({ where }: any) =>
            Array.isArray(where.OR) ? (counts.outboxExhausted ?? 0) : (counts.outboxBacklog ?? 0),
          ),
        },
        notifyLog: {
          // 带 error.startsWith 的那次查的是「业主未授权（43101）」的子集
          count: jest.fn(async ({ where }: any) =>
            where.error?.startsWith ? (counts.notifyUnauthorized ?? 0) : (counts.notifyFailed ?? 0),
          ),
        },
      },
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

  it('Outbox 积压与重试耗尽分别统计，通知失败数取近 30 日', async () => {
    const prisma = makePrisma({ outboxBacklog: 7, outboxExhausted: 2, notifyFailed: 16 });
    const m = await make(prisma).metrics({ tenantId: 't1', now });
    expect(m.outboxBacklog).toBe(7);
    expect(m.outboxExhausted).toBe(2);
    expect(m.notifyFailedCount).toBe(16);
  });

  it('积压查询必须排除终态哨兵，且与领取条件一致地排除超次数事件', async () => {
    const prisma = makePrisma({});
    await make(prisma).metrics({ tenantId: 't1', now });
    const calls = (prisma as any).raw.outboxEvent.count.mock.calls.map((c: any[]) => c[0].where);
    const backlog = calls.find((w: any) => Array.isArray(w.status?.in));
    expect(backlog.availableAt.not).toBeInstanceOf(Date);
    expect(backlog.availableAt.not.getUTCFullYear()).toBe(9999);
    /*
     * 领取条件里有 attempts < MAX；积压统计若不带同样限制，超次数却尚未打上终态
     * 哨兵的事件会被误算成「待投递」，而它们其实永远不会再被领取。
     */
    expect(backlog.attempts).toEqual({ lt: 5 });

    const abandoned = calls.find((w: any) => Array.isArray(w.OR));
    expect(abandoned.OR).toHaveLength(2);
  });
});

/**
 * 指标必须衡量「当时发生了什么」，不是「现在是什么状态」。
 *
 * 2026-08-01 生产实测暴露的问题：当天 4 笔支付全部成功、随后全额退款，
 * 而运维日报表上这一天显示 **0/0** —— 看图的人以为一整天没有交易。
 *
 * 根子在 SQL：`SUM(CASE WHEN status='SUCCESS')` 读的是**当前**状态，
 * 而退款后状态变成 REFUNDED，于是这笔支付从分子和分母里同时消失。
 *
 * 更糟的推论：某天 10 笔支付，9 笔成功后退款、1 笔失败 →
 * 指标显示 0/1 = 0%，「支付全线失败」，而真实成功率是 90%。
 * 一个会在真实场景下给出完全相反结论的指标，比没有指标更危险。
 */
describe('支付成功率的口径', () => {
  function prismaFor(handler: (where: any) => number) {
    const daily: any[] = [];
    return {
      t: {
        payment: { count: jest.fn(async ({ where }: any) => handler(where)), groupBy: jest.fn(async () => []) },
        refund: { count: jest.fn(async () => 0) },
        reconciliationItem: { count: jest.fn(async () => 0) },
        incident: { count: jest.fn(async () => 0) },
      },
      raw: {
        $queryRaw: jest.fn(async () => daily),
        outboxEvent: { count: jest.fn(async () => 0) },
        notifyLog: { count: jest.fn(async () => 0) },
      },
    };
  }

  it('退款过的支付仍计入成功——否则退款会把交易从报表里抹掉', async () => {
    const seen: any[] = [];
    const prisma = prismaFor((w) => {
      seen.push(w);
      return 0;
    });
    await new PilotMetricsService(prisma as never).metrics({ tenantId: 't1', now: new Date('2026-08-02T00:00:00Z') });
    const successWhere = seen.find((w) => w.status?.in?.includes('SUCCESS') && !w.status.in.includes('FAILED'));
    expect(successWhere).toBeDefined();
    expect(successWhere.status.in).toEqual(expect.arrayContaining(['SUCCESS', 'REFUNDED']));
  });

  it('只统计线上渠道——线下登记是手工录入，永远成功，会稀释真实可靠性', async () => {
    const seen: any[] = [];
    const prisma = prismaFor((w) => {
      seen.push(w);
      return 0;
    });
    await new PilotMetricsService(prisma as never).metrics({ tenantId: 't1', now: new Date('2026-08-02T00:00:00Z') });
    for (const w of seen.filter((x) => x.status?.in)) {
      expect(w.channel).toBe('WXPAY');
    }
  });

  it('每日曲线与总体聚合口径一致——两处不一致会讲两个故事', () => {
    /*
     * 曲线用的是原生 SQL、聚合用的是 Prisma count，两边各写一次条件。
     * 只改一边的话，「总体 100%」和「每天 0%」会同时出现在一个页面上，
     * 而看的人无从判断该信哪个。
     */
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'pilot-metrics.service.ts'),
      'utf8',
    ) as string;
    const i = src.indexOf('private async dailyPaymentSuccess');
    const sql = src.slice(i, src.indexOf('`);', i));
    expect(sql).toMatch(/IN \('SUCCESS','REFUNDED'\)/);
    expect(sql).toMatch(/IN \('SUCCESS','REFUNDED','FAILED'\)/);
    expect(sql).toMatch(/channel.*=\s*'WXPAY'/s);
  });
});

describe('通知失败要分清「业主没授权」和「系统坏了」', () => {
  /*
   * 微信一次性订阅：业主授权一次只能收一条，额度用完后再发就是
   * 43101 user refuse to accept the msg —— 不是故障，是这类订阅的固有限制。
   * 生产实测 15 条失败里绝大多数是它。
   *
   * 不分开的后果不是「数字难看」，而是**真故障被埋掉**：
   * 模板 ID 配错、openid 失效这些必须有人处理的失败，
   * 混在十几条 43101 里没人会发现。
   */
  function prismaWith(total: number, unauthorized: number) {
    return {
      t: {
        payment: { count: jest.fn(async () => 0), groupBy: jest.fn(async () => []) },
        refund: { count: jest.fn(async () => 0) },
        reconciliationItem: { count: jest.fn(async () => 0) },
        incident: { count: jest.fn(async () => 0) },
      },
      raw: {
        $queryRaw: jest.fn(async () => []),
        outboxEvent: { count: jest.fn(async () => 0) },
        notifyLog: {
          count: jest.fn(async ({ where }: any) => (where.error?.startsWith ? unauthorized : total)),
        },
      },
    };
  }

  it('拆出未授权与真故障两个数', async () => {
    const m = (await new PilotMetricsService(prismaWith(15, 13) as never).metrics({
      tenantId: 't1',
      now: new Date('2026-08-02T00:00:00Z'),
    })) as unknown as Record<string, number>;
    expect(m.notifyFailedCount).toBe(15);
    expect(m.notifyUnauthorizedCount).toBe(13);
    expect(m.notifySystemFailedCount).toBe(2);
  });

  it('按 43101 判定未授权，不是靠猜', async () => {
    const prisma = prismaWith(1, 1);
    await new PilotMetricsService(prisma as never).metrics({ tenantId: 't1', now: new Date('2026-08-02T00:00:00Z') });
    const calls = (prisma.raw.notifyLog.count as jest.Mock).mock.calls.map((c) => c[0].where);
    expect(calls.some((w: any) => w.error?.startsWith === '43101')).toBe(true);
  });

  it('系统故障数不会为负——总数与子集分两次查，理论上可能错位', async () => {
    const m = (await new PilotMetricsService(prismaWith(2, 5) as never).metrics({
      tenantId: 't1',
      now: new Date('2026-08-02T00:00:00Z'),
    })) as unknown as Record<string, number>;
    expect(m.notifySystemFailedCount).toBe(0);
  });
});
