import { Prisma } from '@prisma/client';

/**
 * 结构化类型写入 Prisma Json 列的唯一桥梁。
 *
 * 为什么需要它：Prisma 的 InputJsonValue 要求索引签名，而普通 interface 没有
 * （`SkippedSummary` 这类类型明明字段全是 number/string/数组，TS 仍拒绝赋值）。
 * 此前的做法是 `as never` —— 那不只绕过这一处，还让「误把 Decimal 或 Date 塞进
 * Json 列」这类真错误一起通过：Decimal 序列化出来是 {s,e,d} 内部结构，
 * Date 变成字符串后再读出来不是 Date，两者都要到线上才发现。
 *
 * JsonCompatible 把这个洞补上：带方法的类实例（Decimal、Dayjs 之类）与 Date
 * 在类型层面就被拒绝，而结构化的纯数据类型照常通过。
 * 于是这里既解决了索引签名问题，又比 as never 严格。
 */

/** 纯数据形状：函数与 Date 一律拒绝，其余递归展开 */
export type JsonCompatible<T> = T extends (...args: never[]) => unknown
  ? never
  : T extends Date
    ? never
    : T extends Array<infer U>
      ? Array<JsonCompatible<U>>
      : T extends object
        ? { [K in keyof T]: JsonCompatible<T[K]> }
        : T;

/**
 * 写入 Json 列。
 *
 * 断言集中在这一处、有名字、可被 grep —— 而散落各处的 `as never` 既看不出意图，
 * 也顺手关掉了别的检查。
 */
export function toJsonColumn<T>(value: T & JsonCompatible<T>): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}
