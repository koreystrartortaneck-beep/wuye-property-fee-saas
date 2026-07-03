/**
 * 金额工具：对外字符串"元"（两位小数），内部计算一律整数"分"。
 * 全局约束：金额永不使用浮点做业务运算。
 */

/** 元（字符串或数字）→ 分（整数，四舍五入） */
export function toCents(yuan: string | number): number {
  const n = typeof yuan === 'string' ? Number(yuan) : yuan;
  if (!Number.isFinite(n)) {
    throw new Error(`非法金额: ${yuan}`);
  }
  return Math.round(n * 100);
}

/** 分 → 元字符串（两位小数） */
export function centsToStr(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`分必须为整数: ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
