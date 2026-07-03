import { Parser } from 'expr-eval';

export class FormulaError extends Error {}

/** 独立 Parser 实例：禁掉赋值等危险能力 */
function makeParser(): Parser {
  return new Parser({
    operators: {
      assignment: false,
      concatenate: false,
      conditional: true,
      logical: false,
      comparison: false,
    },
  });
}

/**
 * 解析并校验公式：只允许出现 allowedVars 中的变量，禁止函数调用。
 * 返回表达式对象（校验用），异常抛 FormulaError。
 */
export function parseFormula(expr: string, allowedVars: string[]): void {
  let parsed;
  try {
    parsed = makeParser().parse(expr);
  } catch (e) {
    throw new FormulaError(`表达式语法错误: ${e instanceof Error ? e.message : e}`);
  }
  // 1) 禁函数调用（IFUNCALL 指令）
  const tokens = (parsed as unknown as { tokens: { type: string }[] }).tokens;
  if (tokens.some((t) => t.type === 'IFUNCALL' || t.type === 'IFUNDEF')) {
    throw new FormulaError('公式不允许函数调用');
  }
  // 2) symbols() 含全部符号（变量+函数名），对照白名单拒绝未知符号
  const symbols = parsed.symbols({ withMembers: true });
  const unknown = symbols.filter((s: string) => !allowedVars.includes(s));
  if (unknown.length > 0) {
    throw new FormulaError(`公式包含未声明的变量或函数: ${unknown.join(', ')}`);
  }
}

/** 求值：scope 内为全部可用变量 */
export function evalFormula(expr: string, scope: Record<string, number>): number {
  try {
    const result: unknown = makeParser().parse(expr).evaluate(scope);
    if (typeof result !== 'number') throw new FormulaError('公式结果不是数值');
    return result;
  } catch (e) {
    if (e instanceof FormulaError) throw e;
    throw new FormulaError(`公式求值失败: ${e instanceof Error ? e.message : e}`);
  }
}
