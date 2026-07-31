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
      /*
       * 必须整数相乘再除，不能用「分 × 浮点面积」。
       *
       * 原写法 Math.round(toCents(unitPrice) * Number(house.area)) 会少算 1 分：
       * 单价 0.15 元、面积 130.70 ㎡，精确值 19.605 元 = 1960.5 分应进位到 1961，
       * 但 15 * 130.70 在 IEEE754 里是 1960.4999…，Math.round 得 1960。
       * 穷举两位小数的单价×面积组合（857 万组）有 7614 组不一致，约 0.09%。
       * 对账也发现不了——本地与渠道用的是同一个错误值。
       *
       * 面积是 Decimal(10,2)，toCents 后是精确整数；两个整数的乘积在
       * 2^53 内精确（单价分 ~1e6 × 面积分 ~1e6 ≈ 1e12），再除 100 取整即为
       * 正确的四舍五入。
       */
      const cents = Math.round((toCents(unitPrice) * toCents(house.area)) / 100);
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
      // 与 AREA_PRICE 同理：读数是 Decimal(12,2)，必须整数相乘再除，否则同样少算 1 分
      const cents = Math.round((toCents(unitPrice) * toCents(diff)) / 100);
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
