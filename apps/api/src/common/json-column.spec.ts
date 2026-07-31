import { Prisma } from '@prisma/client';
import { toJsonColumn, type JsonCompatible } from './json-column';

/**
 * toJsonColumn 取代的是全库 37 处 `as never`。
 *
 * 值级的 `as never` 看着无害，实际把这一处的一切检查都关掉了：
 * `amount: bill.amount as never` 意味着往金额列里塞任何东西都编译通过，
 * 而 `snapshot: x as never` 允许把 Decimal 或 Date 存进 Json 列 ——
 * Decimal 序列化出来是 {s,e,d} 内部结构，Date 读回来不再是 Date，都得等线上才发现。
 *
 * 所以这里既要证明「结构化数据能过」，也要证明「Decimal / Date 过不去」。
 */
describe('Json 列的唯一桥梁', () => {
  it('结构化纯数据原样通过', () => {
    const summary = { total: 3, truncated: false, byReason: { A: 2 }, samples: [{ id: 'x' }] };
    expect(toJsonColumn(summary)).toEqual(summary);
  });

  it('类型层面拒绝 Date 与带方法的实例', () => {
    /*
     * 用类型断言而非运行时断言：这条防护本来就发生在编译期。
     * @ts-expect-error 若哪天类型放宽到能接受它们，这里会因为「预期的错误没出现」而失败 ——
     * 正好是我们要的信号。
     */
    class DecimalLike {
      s = 1;
      toFixed(): string {
        return '1';
      }
    }
    // @ts-expect-error Date 不是纯数据：存进去读出来不再是 Date
    const a: JsonCompatible<{ at: Date }> = { at: new Date() };
    // @ts-expect-error 带方法的实例序列化后只剩内部字段（Decimal 会变成 {s,e,d}）
    const b: JsonCompatible<{ amount: DecimalLike }> = { amount: new DecimalLike() };
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });

  it('返回值类型是 Prisma 的 InputJsonValue', () => {
    // 钉住桥梁的出口类型：换成 any 会让所有调用点重新失去检查
    const v: Prisma.InputJsonValue = toJsonColumn({ a: 1 });
    expect(v).toEqual({ a: 1 });
  });
});
