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

/*
 * ───────────── 按户周年账期（PeriodScheme.ANNIVERSARY） ─────────────
 *
 * 物业的收费规律：每户从各自放户日起算年度。3/15 放户 →
 * 2026 年度的账期是 2026-03-15 ~ 2027-03-14，全小区没有统一的出账日。
 *
 * 账期标签取**起始日的 ISO 串**（'2026-03-15'）：
 *   · 与既有三种标签（'2026-07' / '2026-Q3' / '2026'）字典序混排仍正确 ——
 *     owner 端 /by-period 是按字符串倒序排的，标签格式错一次排序就全乱
 *   · 每户每年唯一 → Bill @@unique([ruleId, houseId, period]) 的幂等锚不变
 *   · 人能读。完整起止区间存账单 snapshot，展示层负责渲染成「2026 年度」
 */

export interface AnniversaryPeriod {
  /** 账期起始（当年周年日） */
  start: Date;
  /** 账期结束（次年周年日前一天） */
  end: Date;
  /** 账期标签 'YYYY-MM-DD'（= start） */
  period: string;
}

const fmtDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * 给定锚点（放户日/挂接起始日）与扫描月 'YYYY-MM'，返回该户在这个月的周年账期；
 * 锚点月份不等于扫描月 → null（这个月不该给这户出账）。
 *
 * 日的钳制：2/29 放户在平年钳到 2/28；1/31 在扫描月是 2 月时不存在——
 * 但这种情况不会发生（锚点月份==扫描月才继续），钳制只对闰日真正生效。
 * 用本地时间构造（与 currentPeriod 一致），不引入 UTC/本地混用。
 */
export function anniversaryPeriod(anchor: Date, runMonth: string): AnniversaryPeriod | null {
  const m = /^(\d{4})-(\d{2})$/.exec(runMonth);
  if (!m) throw new Error(`扫描月格式应为 YYYY-MM，收到 ${runMonth}`);
  const runYear = Number(m[1]);
  const runMonthNum = Number(m[2]);

  if (anchor.getMonth() + 1 !== runMonthNum) return null;

  const daysInMonth = new Date(runYear, runMonthNum, 0).getDate();
  const day = Math.min(anchor.getDate(), daysInMonth);
  const start = new Date(runYear, runMonthNum - 1, day);

  // 结束 = 次年周年日前一天（次年同月同日再钳制，然后 -1 天）
  const daysInNextYearMonth = new Date(runYear + 1, runMonthNum, 0).getDate();
  const nextDay = Math.min(anchor.getDate(), daysInNextYearMonth);
  const end = new Date(runYear + 1, runMonthNum - 1, nextDay);
  end.setDate(end.getDate() - 1);

  return { start, end, period: fmtDate(start) };
}
