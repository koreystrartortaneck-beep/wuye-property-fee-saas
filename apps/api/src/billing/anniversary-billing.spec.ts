import { Prisma } from '@prisma/client';
import { anniversaryPeriod } from './period';
import { calcOne } from './engine/calc';
import { BillRunService } from './bill-run.service';
import { BizException } from '../common/biz.exception';

/**
 * 按户周年出账(PeriodScheme.ANNIVERSARY)。
 *
 * 物业的真实收费规律:每户从各自放户日起算年度,3/15 放户 →
 * 账期 2026-03-15 ~ 2027-03-14,全小区没有统一出账日。
 * 选房只认 HouseStandard 挂接(挂了才出账,不挂 = 免收),
 * 金额 = 月单价 × 面积 × 12,整元半进对齐物业手工账本。
 */

describe('周年账期数学(anniversaryPeriod)', () => {
  it('锚点月份 == 扫描月 → 当年周年区间;标签 = 起始日 ISO 串', () => {
    const ap = anniversaryPeriod(new Date(2019, 2, 15), '2026-03')!;
    expect(ap.period).toBe('2026-03-15');
    expect(ap.start).toEqual(new Date(2026, 2, 15));
    expect(ap.end).toEqual(new Date(2027, 2, 14));
  });

  it('锚点月份 != 扫描月 → null(这个月不该给这户出账)', () => {
    expect(anniversaryPeriod(new Date(2019, 2, 15), '2026-04')).toBeNull();
  });

  it('2/29 放户在平年钳到 2/28,闰年回到 2/29', () => {
    const anchor = new Date(2020, 1, 29);
    expect(anniversaryPeriod(anchor, '2026-02')!.period).toBe('2026-02-28');
    expect(anniversaryPeriod(anchor, '2028-02')!.period).toBe('2028-02-29');
  });

  it('账期标签与既有三种格式字典序混排仍正确 —— owner /by-period 按字符串倒排', () => {
    const labels = ['2026-07', '2026-Q3', '2026', '2026-03-15', '2025-12-01'];
    const sorted = [...labels].sort().reverse();
    // ISO 日期串落在正确的时间位置:2026-03-15 晚于 2025-12-01、早于 2026-07
    expect(sorted.indexOf('2026-03-15')).toBeGreaterThan(sorted.indexOf('2026-07'));
    expect(sorted.indexOf('2026-03-15')).toBeLessThan(sorted.indexOf('2025-12-01'));
  });

  it('扫描月格式错误直接抛,不静默返回 null', () => {
    expect(() => anniversaryPeriod(new Date(2020, 0, 1), '2026-3')).toThrow();
  });
});

describe('年度金额:×12 在引擎里,整元半进只舍一次', () => {
  it('100.24㎡ × 1.4 × 12 = 1684.032 → 整元 1684(与物业手工账本一致)', () => {
    const r = calcOne({
      ruleType: 'AREA_PRICE',
      params: { unitPrice: 1.4 },
      house: { id: 'h1', area: '100.24' },
      months: 12,
      rounding: 'YUAN',
    });
    expect(r).toMatchObject({ ok: true, cents: 168400 });
    if (r.ok) {
      // 舍入前的精确值必须留在快照里,对账才能追
      expect(r.snapshot).toMatchObject({ months: 12, rounding: 'YUAN', rawCents: 168403 });
    }
  });

  it('317.06㎡ × 1.2 × 12 = 4565.664 → 4566(半进,不是截断)', () => {
    const r = calcOne({
      ruleType: 'AREA_PRICE',
      params: { unitPrice: 1.2 },
      house: { id: 'h1', area: '317.06' },
      months: 12,
      rounding: 'YUAN',
    });
    expect(r).toMatchObject({ ok: true, cents: 456600 });
  });

  it('FIXED 的金额是「每账期多少」,不乘 months(商场包租 15000/年)', () => {
    const r = calcOne({
      ruleType: 'FIXED',
      params: { amount: 15000 },
      house: { id: 'h1', area: null },
      months: 12,
      rounding: 'YUAN',
    });
    expect(r).toMatchObject({ ok: true, cents: 1500000 });
  });

  it('不传 months/rounding 时行为与重构前逐分不差(legacy 回归)', () => {
    const r = calcOne({ ruleType: 'AREA_PRICE', params: { unitPrice: 1.4 }, house: { id: 'h1', area: '100.24' } });
    expect(r).toMatchObject({ ok: true, cents: 14034 });
    if (r.ok) expect(r.snapshot).toEqual({ unitPrice: 1.4, area: '100.24' });
  });
});

/* ───────────────────────── 出账管线(mock prisma) ───────────────────────── */

const RULE = {
  id: 'rule-1',
  name: '住宅物业费',
  communityId: 'c1',
  houseType: 'RESIDENCE',
  ruleType: 'AREA_PRICE',
  params: { unitPrice: 1.4 },
  period: 'MONTHLY',
  periodScheme: 'ANNIVERSARY',
  rounding: 'YUAN',
  billDay: 1,
  dueDays: 15,
  enabled: true,
};

function makeHouse(id: string, code: string, handover: Date | null) {
  return { id, code, displayName: code, area: new Prisma.Decimal('100.24'), handoverDate: handover, status: 'ACTIVE' };
}

function makePrisma(opts: {
  rule?: Record<string, unknown> | null;
  attachments?: Array<Record<string, unknown>>;
  recentBills?: Array<{ houseId: string; period: string }>;
}) {
  const created: Record<string, unknown>[][] = [];
  const writes: string[] = [];
  const prisma = {
    t: {
      feeRule: { findUnique: jest.fn(async () => opts.rule ?? RULE) },
      billBatch: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          writes.push('batch');
          return { id: 'batch-1', ...data };
        }),
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      billRun: {
        upsert: jest.fn(async () => {
          writes.push('run');
          return { id: 'run-1' };
        }),
        update: jest.fn(async () => ({})),
      },
      houseStandard: { findMany: jest.fn(async () => opts.attachments ?? []) },
      house: { findMany: jest.fn(async () => []) },
      bill: {
        findMany: jest.fn(async () => opts.recentBills ?? []),
        createMany: jest.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
          created.push(data);
          writes.push('bills');
          return { count: data.length };
        }),
        aggregate: jest.fn(async () => ({ _sum: { amount: new Prisma.Decimal('0') }, _count: { _all: 0 } })),
      },
      meterReading: { findMany: jest.fn(async () => []) },
      sharePool: { findUnique: jest.fn(async () => null) },
    },
  };
  return { prisma, created, writes };
}

const svc = (prisma: unknown) => new BillRunService(prisma as never, {} as never);

describe('周年出账选房与幂等', () => {
  it('只出「放户月 == 扫描月」的户;每户各自的 period/dueDate/年度标题', async () => {
    const { prisma, created } = makePrisma({
      attachments: [
        { houseId: 'h1', startDate: null, endDate: null, house: makeHouse('h1', 'A-1', new Date(2019, 2, 15)) },
        { houseId: 'h2', startDate: null, endDate: null, house: makeHouse('h2', 'A-2', new Date(2019, 7, 2)) }, // 8 月放户,3 月不出
      ],
    });
    const r = await svc(prisma).generate('rule-1', '2026-03');
    expect(created).toHaveLength(1);
    const bills = created[0];
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({
      houseId: 'h1',
      period: '2026-03-15',
      title: '住宅物业费 2026年度',
      amount: '1684.00',
    });
    // 账期起止进 snapshot,业主端据此渲染「2026-03-15 ~ 2027-03-14」
    expect(bills[0].snapshot).toMatchObject({ periodStart: '2026-03-15', periodEnd: '2027-03-14' });
    expect(r.generated).toBe(1);
  });

  it('缺放户日期 → 明确跳过 HANDOVER_DATE_MISSING,绝不静默丢', async () => {
    const { prisma } = makePrisma({
      attachments: [{ houseId: 'h1', startDate: null, endDate: null, house: makeHouse('h1', 'A-1', null) }],
    });
    const r = await svc(prisma).generate('rule-1', '2026-03');
    expect(r.skipped).toBe(1);
    expect(r.skippedDetail?.[0]).toMatchObject({ reason: 'HANDOVER_DATE_MISSING' });
  });

  it('挂接 startDate 覆盖放户日期作为锚点', async () => {
    const { prisma, created } = makePrisma({
      attachments: [
        { houseId: 'h1', startDate: new Date(2025, 2, 20), endDate: null, house: makeHouse('h1', 'A-1', new Date(2019, 7, 2)) },
      ],
    });
    await svc(prisma).generate('rule-1', '2026-03');
    expect(created[0][0]).toMatchObject({ period: '2026-03-20' });
  });

  it('已摘除(endDate 过期)的挂接不再出账', async () => {
    const { prisma, created } = makePrisma({
      attachments: [
        { houseId: 'h1', startDate: null, endDate: new Date(2025, 11, 31), house: makeHouse('h1', 'A-1', new Date(2019, 2, 15)) },
      ],
    });
    const r = await svc(prisma).generate('rule-1', '2026-03');
    expect(created).toHaveLength(0);
    expect(r.generated).toBe(0);
  });

  it('防双账单:锚点被改后同一房年不出第二张(ANNIVERSARY_ALREADY_BILLED)', async () => {
    /*
     * 放户日期从 3/15 改成 3/20 → 新 period '2026-03-20' 与旧 '2026-03-15' 不同,
     * 精确唯一键拦不住 —— 必须按「最近一年内已有账单」查重。
     */
    const { prisma, created } = makePrisma({
      attachments: [
        { houseId: 'h1', startDate: null, endDate: null, house: makeHouse('h1', 'A-1', new Date(2019, 2, 20)) },
      ],
      recentBills: [{ houseId: 'h1', period: '2026-03-15' }],
    });
    const r = await svc(prisma).generate('rule-1', '2026-03');
    expect(created).toHaveLength(0);
    expect(r.skippedDetail?.[0]).toMatchObject({ reason: 'ANNIVERSARY_ALREADY_BILLED' });
  });

  it('同 period 的已有账单不算冲突——那是重跑补漏的正常路径,交给唯一键幂等', async () => {
    const { prisma, created } = makePrisma({
      attachments: [
        { houseId: 'h1', startDate: null, endDate: null, house: makeHouse('h1', 'A-1', new Date(2019, 2, 15)) },
      ],
      recentBills: [{ houseId: 'h1', period: '2026-03-15' }],
    });
    const r = await svc(prisma).generate('rule-1', '2026-03');
    // 重新入池,由 createMany skipDuplicates 幂等跳过(mock 里表现为照常 stage)
    expect(created[0][0]).toMatchObject({ period: '2026-03-15' });
    expect(r.skippedDetail ?? []).toHaveLength(0);
  });

  it('legacy 规则历史上的月账单标签(2026-03)不会被误判成周年冲突', async () => {
    const { prisma, created } = makePrisma({
      attachments: [
        { houseId: 'h1', startDate: null, endDate: null, house: makeHouse('h1', 'A-1', new Date(2019, 2, 15)) },
      ],
      recentBills: [{ houseId: 'h1', period: '2026-03' }], // 7 字符 legacy 标签
    });
    await svc(prisma).generate('rule-1', '2026-03');
    expect(created[0]).toHaveLength(1);
  });

  it('剔除的户计入 skippedDetail(EXCLUDED_BY_ADMIN),不静默少出', async () => {
    const { prisma, created } = makePrisma({
      attachments: [
        { houseId: 'h1', startDate: null, endDate: null, house: makeHouse('h1', 'A-1', new Date(2019, 2, 15)) },
        { houseId: 'h2', startDate: null, endDate: null, house: makeHouse('h2', 'A-2', new Date(2019, 2, 18)) },
      ],
    });
    const r = await svc(prisma).generate('rule-1', '2026-03', { excludeHouseIds: ['h2'] });
    expect(created[0].map((b) => b.houseId)).toEqual(['h1']);
    expect(r.skippedDetail?.some((s) => s.houseId === 'h2' && s.reason === 'EXCLUDED_BY_ADMIN')).toBe(true);
  });

  it('周年方案的扫描键必须是 YYYY-MM', async () => {
    const { prisma } = makePrisma({ attachments: [] });
    await expect(svc(prisma).generate('rule-1', '2026')).rejects.toThrow(BizException);
  });

  it('SHARE/METER 不支持周年 —— 明确拒绝,不静默出错账', async () => {
    const { prisma } = makePrisma({ rule: { ...RULE, ruleType: 'SHARE', params: { shareBy: 'AREA' } } });
    await expect(svc(prisma).generate('rule-1', '2026-03')).rejects.toThrow(/周年/);
  });

  it('dueDate = 账期起始 + dueDays,补跑历史月时下限 now+7 天(不生成一出生就逾期的账单)', async () => {
    const { prisma, created } = makePrisma({
      attachments: [
        { houseId: 'h1', startDate: null, endDate: null, house: makeHouse('h1', 'A-1', new Date(2019, 0, 10)) },
      ],
    });
    await svc(prisma).generate('rule-1', '2020-01'); // 远古扫描月
    const due = new Date(created[0][0].dueDate as Date);
    const floor = new Date();
    floor.setDate(floor.getDate() + 6);
    expect(due.getTime()).toBeGreaterThan(floor.getTime());
  });
});

describe('preview 纯读', () => {
  it('给出每行金额与依据,且一次写库都没有', async () => {
    const { prisma, writes } = makePrisma({
      attachments: [
        { houseId: 'h1', startDate: null, endDate: null, house: makeHouse('h1', 'A-1', new Date(2019, 2, 15)) },
        { houseId: 'h2', startDate: null, endDate: null, house: makeHouse('h2', 'A-2', null) },
      ],
    });
    const r = await svc(prisma).preview('rule-1', '2026-03');
    expect(writes).toHaveLength(0); // 批次/run/账单,一个都不许写
    expect(r.total).toBe('1684.00');
    const ok = r.rows.find((row) => row.houseId === 'h1')!;
    expect(ok).toMatchObject({ period: '2026-03-15', amount: '1684.00' });
    expect(ok.snapshot).toMatchObject({ unitPrice: 1.4, months: 12 });
    const miss = r.rows.find((row) => row.houseId === 'h2')!;
    expect(miss.skipReason).toBe('HANDOVER_DATE_MISSING');
  });
});

describe('定向出账(某一户 / 某几户 / 全部)', () => {
  const three = () =>
    makePrisma({
      attachments: [
        { houseId: 'h1', startDate: null, endDate: null, house: makeHouse('h1', 'A-1', new Date(2019, 2, 15)) },
        { houseId: 'h2', startDate: null, endDate: null, house: makeHouse('h2', 'A-2', new Date(2019, 2, 16)) },
        { houseId: 'h3', startDate: null, endDate: null, house: makeHouse('h3', 'A-3', new Date(2019, 2, 17)) },
      ],
    });

  it('只给选中的户出账', async () => {
    const { prisma, created } = three();
    await svc(prisma).generate('rule-1', '2026-03', { onlyHouseIds: ['h2'] });
    expect(created[0].map((b) => b.houseId)).toEqual(['h2']);
  });

  it('未选中的户不算「跳过」——它们不是被拦下,是本次没打算出', async () => {
    /*
     * 混淆这两者的后果:skippedDetail 里躺着 548 条「跳过」,
     * 物业以为出账出错了,而实际上他只是给一户补了张账单。
     */
    const { prisma } = three();
    const r = await svc(prisma).generate('rule-1', '2026-03', { onlyHouseIds: ['h2'] });
    expect(r.skipped).toBe(0);
    expect(r.skippedDetail ?? []).toHaveLength(0);
  });

  it('定向与剔除叠加:先收窄再剔除,剔除的仍计入跳过', async () => {
    const { prisma, created } = three();
    const r = await svc(prisma).generate('rule-1', '2026-03', {
      onlyHouseIds: ['h1', 'h2'],
      excludeHouseIds: ['h2'],
    });
    expect(created[0].map((b) => b.houseId)).toEqual(['h1']);
    expect(r.skippedDetail?.some((s) => s.houseId === 'h2' && s.reason === 'EXCLUDED_BY_ADMIN')).toBe(true);
  });

  it('不传 onlyHouseIds = 全部(既有行为不变)', async () => {
    const { prisma, created } = three();
    await svc(prisma).generate('rule-1', '2026-03');
    expect(created[0]).toHaveLength(3);
  });

  it('定向出账仍进同一批次——分几次补齐不该变成几个批次', async () => {
    /*
     * 批次是「这条标准这个月的账」。若定向另建批次,发布要点好几次、
     * 合计也对不上,而物业只会觉得「怎么又多出一批」。
     */
    const { prisma } = three();
    const a = await svc(prisma).generate('rule-1', '2026-03', { onlyHouseIds: ['h1'] });
    const b = await svc(prisma).generate('rule-1', '2026-03', { onlyHouseIds: ['h2'] });
    expect(a.batchId).toBe(b.batchId);
  });

  it('预览必须与出账同口径:选了几户就只预览几户', async () => {
    const { prisma } = three();
    const r = await svc(prisma).preview('rule-1', '2026-03', ['h3']);
    expect(r.rows.map((x) => x.houseId)).toEqual(['h3']);
  });
});
