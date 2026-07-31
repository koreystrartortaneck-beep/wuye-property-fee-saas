import { calcOne } from './calc';

describe('calcOne：单户计费', () => {
  it('AREA_PRICE：2.5 × 128 = 320.00', () => {
    const r = calcOne({
      ruleType: 'AREA_PRICE',
      params: { unitPrice: 2.5 },
      house: { id: 'h1', area: '128' },
    });
    expect(r).toEqual({
      ok: true,
      cents: 32000,
      snapshot: { unitPrice: 2.5, area: '128' },
    });
  });

  it('AREA_PRICE：面积缺失 → skip', () => {
    const r = calcOne({ ruleType: 'AREA_PRICE', params: { unitPrice: 2.5 }, house: { id: 'h1', area: null } });
    expect(r).toEqual({ ok: false, skipReason: 'AREA_MISSING' });
  });

  it('FIXED：360 → 36000 分', () => {
    const r = calcOne({ ruleType: 'FIXED', params: { amount: 360 }, house: { id: 'h1', area: null } });
    expect(r).toMatchObject({ ok: true, cents: 36000 });
  });

  it('METER：0.6 × 34.2 = 20.52', () => {
    const r = calcOne({
      ruleType: 'METER',
      params: { unitPrice: 0.6, meterType: 'WATER' },
      house: { id: 'h1', area: null },
      readingDiff: 34.2,
    });
    expect(r).toMatchObject({ ok: true, cents: 2052 });
    if (r.ok) expect(r.snapshot).toMatchObject({ unitPrice: 0.6, readingDiff: 34.2, meterType: 'WATER' });
  });

  it('METER：缺读数 → skip', () => {
    const r = calcOne({
      ruleType: 'METER',
      params: { unitPrice: 0.6, meterType: 'WATER' },
      house: { id: 'h1', area: null },
      readingDiff: null,
    });
    expect(r).toEqual({ ok: false, skipReason: 'METER_READING_MISSING' });
  });

  it('FORMULA：area*price*0.9, price=2.5, area=100 → 225.00', () => {
    const r = calcOne({
      ruleType: 'FORMULA',
      params: { expr: 'area * price * 0.9', vars: { price: 2.5 } },
      house: { id: 'h1', area: '100' },
    });
    expect(r).toMatchObject({ ok: true, cents: 22500 });
  });

  it('FORMULA：结果非有限数 → skip', () => {
    const r = calcOne({
      ruleType: 'FORMULA',
      params: { expr: 'area / zero', vars: { zero: 0 } },
      house: { id: 'h1', area: '100' },
    });
    expect(r).toEqual({ ok: false, skipReason: 'FORMULA_INVALID' });
  });

  it('FORMULA：负数结果 → skip', () => {
    const r = calcOne({
      ruleType: 'FORMULA',
      params: { expr: 'area - 200', vars: {} },
      house: { id: 'h1', area: '100' },
    });
    expect(r).toEqual({ ok: false, skipReason: 'FORMULA_INVALID' });
  });

  it('FORMULA：公式用到 area 但房屋无面积 → skip', () => {
    const r = calcOne({
      ruleType: 'FORMULA',
      params: { expr: 'area * 2', vars: {} },
      house: { id: 'h1', area: null },
    });
    expect(r).toEqual({ ok: false, skipReason: 'AREA_MISSING' });
  });

  it('SHARE 走批量接口，calcOne 收到直接抛程序错误', () => {
    expect(() =>
      calcOne({ ruleType: 'SHARE', params: { shareBy: 'AREA' }, house: { id: 'h1', area: '100' } }),
    ).toThrow();
  });
});

/**
 * 金额精度：面积/读数与单价相乘必须走整数，不能「分 × 浮点」。
 *
 * 原实现 Math.round(toCents(unitPrice) * Number(house.area)) 会少算 1 分：
 * 单价 0.15 元、面积 130.70 ㎡，精确值 19.605 元 = 1960.5 分应进位到 1961，
 * 而 15 * 130.70 在 IEEE754 里是 1960.4999…，Math.round 得 1960。
 * 穷举两位小数的单价×面积组合（857 万组）有 7614 组不一致，约 0.09%。
 * 对账也发现不了——本地与渠道用的是同一个错误值。
 */
describe('计费金额精度（整数运算）', () => {
  /** 精确基准：单价分 × 面积分 / 100，四舍五入 */
  function exactCents(unitPriceYuan: string, areaYuan: string): number {
    const pc = Math.round(Number(unitPriceYuan) * 100);
    const ac = Math.round(Number(areaYuan) * 100);
    return Math.round((pc * ac) / 100);
  }

  it('单价 0.15 × 面积 130.70：必须是 1961 分，不是 1960', () => {
    const r = calcOne({
      ruleType: 'AREA_PRICE',
      params: { unitPrice: 0.15 },
      house: { id: 'h1', area: '130.70' },
    });
    expect(r).toMatchObject({ ok: true });
    expect((r as { cents: number }).cents).toBe(1961);
    // 这正是修复前算出来的错误值
    expect((r as { cents: number }).cents).not.toBe(1960);
  });

  it('一组已知的边界组合都与精确值一致', () => {
    const cases: Array<[string, string]> = [
      ['0.15', '130.70'],
      ['2.50', '89.99'],
      ['2.50', '118.50'],
      ['1.80', '99.99'],
      ['3.20', '66.66'],
      ['0.05', '333.30'],
      ['12.34', '56.78'],
    ];
    for (const [price, area] of cases) {
      const r = calcOne({
        ruleType: 'AREA_PRICE',
        params: { unitPrice: Number(price) },
        house: { id: 'h1', area },
      });
      expect((r as { cents: number }).cents).toBe(exactCents(price, area));
    }
  });

  it('用量计费同样走整数：单价 0.15 × 用量 130.70 = 1961 分', () => {
    const r = calcOne({
      ruleType: 'METER',
      params: { unitPrice: 0.15, meterType: 'WATER' },
      house: { id: 'h1', area: null },
      readingDiff: 130.7,
    });
    expect((r as { cents: number }).cents).toBe(1961);
  });

  it('抽样一万组两位小数组合，全部与精确值一致', () => {
    let checked = 0;
    for (let pc = 1; pc <= 100; pc += 1) {
      for (let ac = 1; ac <= 30000; ac += 307) {
        const price = (pc / 100).toFixed(2);
        const area = (ac / 100).toFixed(2);
        const r = calcOne({
          ruleType: 'AREA_PRICE',
          params: { unitPrice: Number(price) },
          house: { id: 'h1', area },
        });
        expect((r as { cents: number }).cents).toBe(exactCents(price, area));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(9000);
  });
});
