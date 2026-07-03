import { RulePeriod } from '@pf/shared';

/**
 * 计算给定日期在某周期类型下的账期标签（spec §6.3）。
 * - MONTHLY：每月 → '2026-07'
 * - QUARTERLY：仅 1/4/7/10 月为周期锚点 → '2026-Q3'，非锚点月返回 null
 * - YEARLY：仅 1 月 → '2026'
 */
export function currentPeriod(date: Date, period: RulePeriod): string | null {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  switch (period) {
    case 'MONTHLY':
      return `${y}-${String(m).padStart(2, '0')}`;
    case 'QUARTERLY':
      if (![1, 4, 7, 10].includes(m)) return null;
      return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    case 'YEARLY':
      return m === 1 ? `${y}` : null;
  }
}
