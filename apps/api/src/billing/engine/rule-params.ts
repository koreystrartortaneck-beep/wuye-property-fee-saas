import { ErrorCode, METER_TYPES, RuleType, SHARE_BY } from '@pf/shared';
import { BizException } from '../../common/biz.exception';
import { FormulaError, evalFormula, parseFormula } from './formula';

function isPositiveNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * 校验 FeeRule.params 结构（创建/修改规则时调用）。
 * 不合法抛 42001；FORMULA 语法/变量问题抛 42005。
 */
export function validateRuleParams(ruleType: RuleType, params: Record<string, unknown>): void {
  switch (ruleType) {
    case 'AREA_PRICE':
      if (!isPositiveNumber(params.unitPrice)) {
        throw new BizException(ErrorCode.RULE_PARAM_INVALID, 'unitPrice 必须为正数');
      }
      return;

    case 'FIXED':
      if (!isNonNegativeNumber(params.amount) || params.amount === 0) {
        throw new BizException(ErrorCode.RULE_PARAM_INVALID, 'amount 必须为正数');
      }
      return;

    case 'METER':
      if (!isPositiveNumber(params.unitPrice)) {
        throw new BizException(ErrorCode.RULE_PARAM_INVALID, 'unitPrice 必须为正数');
      }
      if (!METER_TYPES.includes(params.meterType as never)) {
        throw new BizException(ErrorCode.RULE_PARAM_INVALID, `meterType 必须为 ${METER_TYPES.join('/')}`);
      }
      return;

    case 'SHARE':
      if (!SHARE_BY.includes(params.shareBy as never)) {
        throw new BizException(ErrorCode.RULE_PARAM_INVALID, `shareBy 必须为 ${SHARE_BY.join('/')}`);
      }
      return;

    case 'FORMULA': {
      const expr = params.expr;
      const vars = (params.vars ?? {}) as Record<string, unknown>;
      if (typeof expr !== 'string' || !expr.trim()) {
        throw new BizException(ErrorCode.FORMULA_INVALID, 'expr 不能为空');
      }
      for (const [k, v] of Object.entries(vars)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new BizException(ErrorCode.FORMULA_INVALID, `变量 ${k} 必须为数值`);
        }
      }
      const allowed = ['area', ...Object.keys(vars)];
      try {
        parseFormula(expr, allowed);
        // 试算验证可求值（area=100）
        evalFormula(expr, { ...(vars as Record<string, number>), area: 100 });
      } catch (e) {
        if (e instanceof FormulaError) throw new BizException(ErrorCode.FORMULA_INVALID, e.message);
        throw e;
      }
      return;
    }

    default:
      throw new BizException(ErrorCode.RULE_PARAM_INVALID, `未知规则类型 ${ruleType as string}`);
  }
}
