import { NotifyType } from '@pf/shared';

/**
 * 订阅消息模板字段映射 —— 单一真源。
 *
 * 为什么需要这一层：微信订阅消息的 data 键必须是**模板的字段名**（thing1 /
 * amount2 / date3 …），字段名由你在公众平台选的关键词及其顺序决定，选定提交后
 * 不可修改。而改版前后端两处都直接发业务语义名（title / amount / period /
 * dueDate），微信一律判为参数非法（47003）——也就是说，即便模板 ID 配好了，
 * 通知依然一条也发不出去，而管理端只会看到一句 errcode。
 *
 * 设计取舍：
 *   - 字段名集中在这里，改模板只动一处；
 *   - 同时支持环境变量覆盖（WX_TMPL_FIELD_*），万一线上模板的字段名与预期不同，
 *     不必重新发布就能纠正——这类「名字对不上」的问题只有真实下发才会暴露。
 *
 * 约定使用的关键词（顺序即字段序号）：
 *   1 费用名称  → thing1
 *   2 金额      → amount2
 *   3 到期日期  → date3
 *   4 温馨提示  → thing4
 * 刻意避开「收款类型」：它是常量关键词，只能取审核通过的枚举值，而系统里的
 * 费用名称是自由文本，给不出合法值。也避开「账单日期」：账单只有账期（YYYY-MM），
 * 没有可填进 date 字段的具体日期。
 */

/** 业务语义 → 微信模板字段名 */
export interface SubscribeFieldNames {
  /** 费用名称（thing 类，≤20 字） */
  feeName: string;
  /** 金额（amount 类） */
  amount: string;
  /** 到期日期（date 类） */
  dueDate: string;
  /** 温馨提示（thing 类，≤20 字） */
  tip: string;
}

export const DEFAULT_SUBSCRIBE_FIELDS: SubscribeFieldNames = {
  feeName: 'thing1',
  amount: 'amount2',
  dueDate: 'date3',
  tip: 'thing4',
};

/** 读取字段名，允许用环境变量逐个覆盖 */
export function subscribeFieldNames(): SubscribeFieldNames {
  return {
    feeName: process.env.WX_TMPL_FIELD_FEE_NAME || DEFAULT_SUBSCRIBE_FIELDS.feeName,
    amount: process.env.WX_TMPL_FIELD_AMOUNT || DEFAULT_SUBSCRIBE_FIELDS.amount,
    dueDate: process.env.WX_TMPL_FIELD_DUE_DATE || DEFAULT_SUBSCRIBE_FIELDS.dueDate,
    tip: process.env.WX_TMPL_FIELD_TIP || DEFAULT_SUBSCRIBE_FIELDS.tip,
  };
}

/**
 * 三类通知的「温馨提示」文案。
 * thing 类字段微信限制 20 字以内，这里的文案都已在限长内。
 */
const TIP_BY_TYPE: Record<NotifyType, string> = {
  BILL_CREATED: '账单已生成，请及时缴纳',
  DUE_SOON: '即将到期，请尽快缴纳',
  OVERDUE: '已逾期，请尽快处理',
};

export interface BillFacts {
  /** 费用名称，如「住宅物业费 2026-09」 */
  title: string;
  /** 金额，元，字符串避免精度丢失 */
  amount: string;
  /** 到期日期 YYYY-MM-DD */
  dueDate: string;
}

/**
 * 组装订阅消息 data（键为微信字段名）。
 *
 * 金额带上「元」：amount 类字段微信要求是金额文本，纯数字也能过，
 * 但带单位在业主端更可读，且与小程序内展示一致。
 */
export function buildSubscribeData(type: NotifyType, bill: BillFacts): Record<string, string> {
  const f = subscribeFieldNames();
  return {
    [f.feeName]: bill.title,
    [f.amount]: `${bill.amount}元`,
    [f.dueDate]: bill.dueDate,
    [f.tip]: TIP_BY_TYPE[type] ?? TIP_BY_TYPE.BILL_CREATED,
  };
}
