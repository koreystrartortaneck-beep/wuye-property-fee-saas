import { centsToStr, toCents } from './money';

describe('money：元/分转换', () => {
  it('toCents 精确转换', () => {
    expect(toCents('2486.80')).toBe(248680);
    expect(toCents('0.01')).toBe(1);
    expect(toCents('360')).toBe(36000);
    expect(toCents('2.5')).toBe(250);
  });

  it('toCents 四舍五入到分', () => {
    expect(toCents('20.525')).toBe(2053);
    expect(toCents('20.524')).toBe(2052);
  });

  it('centsToStr 保留两位', () => {
    expect(centsToStr(2052)).toBe('20.52');
    expect(centsToStr(248680)).toBe('2486.80');
    expect(centsToStr(0)).toBe('0.00');
    expect(centsToStr(5)).toBe('0.05');
  });
});
