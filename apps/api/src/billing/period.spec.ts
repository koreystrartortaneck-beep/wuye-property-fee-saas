import { currentPeriod } from './period';

describe('currentPeriod：账期锚点', () => {
  it('MONTHLY 每月有效', () => {
    expect(currentPeriod(new Date(2026, 6, 1), 'MONTHLY')).toBe('2026-07');
    expect(currentPeriod(new Date(2026, 0, 15), 'MONTHLY')).toBe('2026-01');
  });

  it('QUARTERLY 仅 1/4/7/10 月', () => {
    expect(currentPeriod(new Date(2026, 6, 1), 'QUARTERLY')).toBe('2026-Q3');
    expect(currentPeriod(new Date(2026, 0, 1), 'QUARTERLY')).toBe('2026-Q1');
    expect(currentPeriod(new Date(2026, 7, 1), 'QUARTERLY')).toBeNull();
  });

  it('YEARLY 仅 1 月', () => {
    expect(currentPeriod(new Date(2026, 0, 1), 'YEARLY')).toBe('2026');
    expect(currentPeriod(new Date(2026, 6, 1), 'YEARLY')).toBeNull();
  });
});
