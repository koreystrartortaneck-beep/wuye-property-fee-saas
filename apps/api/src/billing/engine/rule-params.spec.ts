import { validateRuleParams } from './rule-params';

describe('validateRuleParams：规则参数校验', () => {
  it('AREA_PRICE 合法/非法', () => {
    expect(() => validateRuleParams('AREA_PRICE', { unitPrice: 2.5 })).not.toThrow();
    expect(() => validateRuleParams('AREA_PRICE', { unitPrice: 0 })).toThrow();
    expect(() => validateRuleParams('AREA_PRICE', {})).toThrow();
  });

  it('FIXED 合法/非法', () => {
    expect(() => validateRuleParams('FIXED', { amount: 360 })).not.toThrow();
    expect(() => validateRuleParams('FIXED', { amount: -1 })).toThrow();
  });

  it('METER 合法/非法', () => {
    expect(() => validateRuleParams('METER', { unitPrice: 0.6, meterType: 'WATER' })).not.toThrow();
    expect(() => validateRuleParams('METER', { unitPrice: 0.6, meterType: 'OIL' })).toThrow();
  });

  it('SHARE 合法/非法', () => {
    expect(() => validateRuleParams('SHARE', { shareBy: 'AREA' })).not.toThrow();
    expect(() => validateRuleParams('SHARE', { shareBy: 'WEIGHT' })).toThrow();
  });

  it('FORMULA：合法表达式通过，函数调用被拒', () => {
    expect(() => validateRuleParams('FORMULA', { expr: 'area * price', vars: { price: 2.5 } })).not.toThrow();
    expect(() => validateRuleParams('FORMULA', { expr: 'pow(2,3)', vars: {} })).toThrow();
    expect(() => validateRuleParams('FORMULA', { expr: 'area +* 2', vars: {} })).toThrow();
    // 引用未声明变量 → 拒绝
    expect(() => validateRuleParams('FORMULA', { expr: 'area * unknownVar', vars: {} })).toThrow();
  });
});
