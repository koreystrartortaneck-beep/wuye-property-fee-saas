import { AmountRounding, RuleType } from '@pf/shared';
import { evalFormula } from './formula';
import { toCents } from './money';

export interface CalcInput {
  ruleType: RuleType;
  /** FeeRule.params（已经过 validateRuleParams 校验） */
  params: Record<string, unknown>;
  house: { id: string; area: string | null };
  /** METER 专用：本期读数 − 上期读数；null 表示缺读数 */
  readingDiff?: number | null;
  /*
   * 账期月数,只作用于 AREA_PRICE(单价的量纲是 元/㎡/月)。
   * 周年年度账单传 12 —— 把「×12」放进引擎而不是让物业把单价填成 16.8:
   * 后者是个必踩的陷阱(填 1.4 → 少收 12 倍,对账还查不出来,
   * 因为本地和微信用的是同一个错误值)。FIXED 的金额本来就是「每账期多少」,不乘。
   */
  months?: number;
  /*
   * 金额取整。YUAN = 半进到整元 —— 物业手工账本按整元记
   * (100.24㎡ × 1.4 × 12 = 1684.032 记 1684),系统必须能对上。
   * 取整发生在**全账期金额算完之后的最后一步**,只舍入一次;
   * snapshot 里保留 rawCents,对账时能看到舍入前的精确值。
   */
  rounding?: AmountRounding;
}

/** 半进到整元(100 分的倍数)。CENT 原样返回。 */
function applyRounding(cents: number, rounding: AmountRounding | undefined): number {
  if (rounding !== 'YUAN') return cents;
  return Math.round(cents / 100) * 100;
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
      const months = input.months ?? 1;
      /*
       * 整段账期一次算完、只舍入一次:先 round 到分,再(可选)半进到元。
       * 分两步(先算月再×12)会引入每月一次的舍入,月月 +0.4 分这类误差
       * 累积起来在 .5 边界上会差出 1 元。整数乘积 ≤1e6×1e6×12≈1.2e13 < 2^53,精确。
       */
      const rawCents = Math.round((toCents(unitPrice) * toCents(house.area) * months) / 100);
      const cents = applyRounding(rawCents, input.rounding);
      return {
        ok: true,
        cents,
        snapshot: {
          unitPrice,
          area: house.area,
          ...(months !== 1 ? { months } : {}),
          ...(input.rounding === 'YUAN' ? { rounding: 'YUAN', rawCents } : {}),
        },
      };
    }

    case 'FIXED': {
      // FIXED 的金额语义是「每账期多少」(商场包租 15000 元/年),不乘 months
      const amount = params.amount as number;
      const rawCents = toCents(amount);
      const cents = applyRounding(rawCents, input.rounding);
      return {
        ok: true,
        cents,
        snapshot: { amount, ...(input.rounding === 'YUAN' && cents !== rawCents ? { rounding: 'YUAN', rawCents } : {}) },
      };
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
