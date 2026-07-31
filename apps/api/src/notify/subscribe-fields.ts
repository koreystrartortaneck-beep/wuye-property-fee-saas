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
 * 实际字段名取自公众平台「模板详情」（模板 33214 缴费业务通知，
 * 类目 物业管理）——注意字段序号并不等于关键词的排列顺序，微信是按
 * 该公共模板的全量关键词编号的：
 *   费用名称 → thing12
 *   金额     → amount4
 *   到期日期 → time3     （time 类，不是 date 类）
 *   温馨提示 → thing11
 * 起初按惯例猜的 thing1 / amount2 / date3 / thing4 四个全错，这类「名字对不上」
 * 只有拿到模板详情或真实下发才知道。
 *
 * 刻意避开两个关键词：「收款类型」是常量关键词，只能取审核通过的枚举值，而系统
 * 里的费用名称是自由文本；「账单日期」我们只有账期 YYYY-MM，没有具体日期。
 */

/** 业务语义 → 微信模板字段名 */
export interface SubscribeFieldNames {
  /** 费用名称（thing 类，≤20 字） */
  feeName: string;
  /** 金额（amount 类） */
  amount: string;
  /** 到期日期（time 类） */
  dueDate: string;
  /** 温馨提示（thing 类，≤20 字） */
  tip: string;
}

export const DEFAULT_SUBSCRIBE_FIELDS: SubscribeFieldNames = {
  feeName: 'thing12',
  amount: 'amount4',
  dueDate: 'time3',
  tip: 'thing11',
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
  /*
   * DUE_SOON 有两个调用方：定时提醒（到期前 3 天）与人工催缴（可能距到期还很远）。
   * 原文案「即将到期」对后者不准确——给一张 26 天后到期的账单说「即将到期」很怪。
   * 改成对两种场景都成立的说法。
   */
  DUE_SOON: '尚未缴纳，请在到期日前缴纳',
  OVERDUE: '已逾期，请尽快处理',
};

export interface BillFacts {
  /** 费用名称，如「住宅物业费 2026-09」 */
  title: string;
  /** 金额，元，字符串避免精度丢失 */
  amount: string;
  /** 到期日期；传 Date 或可被解析的字符串，格式化在本模块内完成 */
  dueDate: string | Date;
}

/**
 * amount 类字段格式：1 个币种符号 + 10 位以内数字（可带小数）。
 * 微信自己的示例卡片渲染成「￥100」，这里照同一形态给，避免格式被判非法。
 */
function formatAmount(yuan: string): string {
  /*
   * 必须补齐两位小数：bill.amount 是 Decimal，toString() 把 2.50 输出成 "2.5"，
   * 业主手机上就显示成「￥2.5」——金额少一位小数，不像正式账单。
   * 用 Number 转换后 toFixed(2)：金额已是 Decimal(12,2)，两位小数内不会有精度问题。
   */
  const n = Number(yuan);
  return `￥${Number.isFinite(n) ? n.toFixed(2) : yuan}`;
}

/**
 * 到期日期落在 time 类字段上，微信示例渲染为「2021年12月31日」，故用同一形态。
 *
 * 必须按上海时区格式化：dueDate 存的是 UTC 时刻，直接 toISOString().slice(0,10)
 * 会让 16:00Z 这类时间少算一天，业主看到的到期日与账单页不一致。
 */
function formatDueDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}年${get('month')}月${get('day')}日`;
}

/** 组装订阅消息 data（键为微信模板字段名） */
export function buildSubscribeData(type: NotifyType, bill: BillFacts): Record<string, string> {
  const f = subscribeFieldNames();
  return {
    [f.feeName]: bill.title,
    [f.amount]: formatAmount(bill.amount),
    [f.dueDate]: formatDueDate(bill.dueDate),
    [f.tip]: TIP_BY_TYPE[type] ?? TIP_BY_TYPE.BILL_CREATED,
  };
}
