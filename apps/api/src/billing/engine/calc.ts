import { RuleType } from '@pf/shared';
import { evalFormula } from './formula';
import { toCents } from './money';

export interface CalcInput {
  ruleType: RuleType;
  /** FeeRule.params（已经过 validateRuleParams 校验） */
  params: Record<string, unknown>;
  house: { id: string; area: string | null };
  /** METER 专用：本期读数 − 上期读数；null 表示缺读数 */
  readingDiff?: number | null;
}

export type CalcResult =
  | { ok: true; cents: number; snapshot: Record<string, unknown> }
  | { ok: false; skipReason: string };

/**
 * 单户计费（纯函数）。SHARE 为跨户批量计算，走 allocateShare，
 * 传进来属于编程错误，直接抛出。
 */
export function calcOne(input: CalcInput): CalcResult {
  const { ruleType, params, house } = input;

  switch (ruleType) {
    case 'AREA_PRICE': {
      const unitPrice = params.unitPrice as number;
      if (house.area === null) return { ok: false, skipReason: 'AREA_MISSING' };
      const cents = Math.round(toCents(unitPrice) * Number(house.area)) ;
      return { ok: true, cents, snapshot: { unitPrice, area: house.area } };
    }

    case 'FIXED': {
      const amount = params.amount as number;
      return { ok: true, cents: toCents(amount), snapshot: { amount } };
    }

    case 'METER': {
      const unitPrice = params.unitPrice as number;
      const meterType = params.meterType as string;
      if (input.readingDiff === null || input.readingDiff === undefined) {
        return { ok: false, skipReason: 'METER_READING_MISSING' };
      }
      // 读数回退在录入层已拒绝；引擎防御性按 0 计
      const diff = Math.max(0, input.readingDiff);
      const cents = Math.round(toCents(unitPrice) * diff);
      return { ok: true, cents, snapshot: { unitPrice, readingDiff: input.readingDiff, meterType } };
    }

    case 'FORMULA': {
      const expr = params.expr as string;
      const vars = (params.vars ?? {}) as Record<string, number>;
      const usesArea = /\barea\b/.test(expr);
      if (usesArea && house.area === null) return { ok: false, skipReason: 'AREA_MISSING' };
      try {
        const value = evalFormula(expr, { ...vars, area: house.area === null ? 0 : Number(house.area) });
        if (!Number.isFinite(value) || value < 0) return { ok: false, skipReason: 'FORMULA_INVALID' };
        return { ok: true, cents: toCents(value), snapshot: { expr, vars, area: house.area } };
      } catch {
        return { ok: false, skipReason: 'FORMULA_INVALID' };
      }
    }

    case 'SHARE':
      throw new Error('SHARE 规则为跨户批量计算，请使用 allocateShare');

    default:
      throw new Error(`未知规则类型: ${ruleType as string}`);
  }
}
