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
