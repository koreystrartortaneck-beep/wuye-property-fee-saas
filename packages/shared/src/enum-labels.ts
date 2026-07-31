/**
 * 枚举的中文文案 —— 单一真源。
 *
 * 为什么需要它：
 *
 * 1) 后端有三处把英文枚举直接拼进给**业主**看的提示里：
 *      「账单「物业费」状态为 UNPAID」   payment.service.ts
 *      「订单状态 CREATED」              payment.service.ts
 *      「当前状态 ACTIVE」               visitors.service.ts
 *    而小程序 utils/request.js 是把后端 message 原样 toast 的，所以业主真的会
 *    看到 UNPAID、CREATED、ACTIVE 这些词。labels.js 顶部注释立誓要避免的事，
 *    在后端这一侧漏了。
 *
 * 2) 后台与小程序对**同一个** key 的中文并不一致，业主和物业打电话时对不上：
 *      BillStatus.DRAFT              后台「草稿」   / 小程序「未发布」
 *      InvoiceStatus.REVERSAL_REQUIRED 后台「需红冲」 / 小程序「待红冲」
 *      PassStatus.USED               后台「已核销」 / 小程序「已使用」
 *      CouponType.DISCOUNT           后台「满减抵扣」/ 小程序「满减」
 *      WorkCategory.INSPECTION       后台「日常巡检」/ 小程序「巡检」「日常巡检」两种
 *      WorkCategory.OTHER            后台「其他」   / 小程序「公示」「其他」两种
 *      ServiceOrderStatus.PENDING    后台「待接单」 / 小程序真源表写「待受理」但实际渲染「待接单」
 *    小程序 labels.js 自己内部也矛盾：PASS_STATUS.USED 是「已使用」，
 *    而 USER_COUPON_STATUS.USED 是「已核销」，同一个 key 在同一个文件里两种译法。
 *
 * 取词原则：业主（含老年居民）能不看解释就懂。
 *   ·「未发布」而不是「草稿」——草稿是编辑器语义；
 *   ·「已使用」而不是「已核销」——核销是财务/门岗术语；
 *   ·「满减」而不是「满减抵扣」——券面本来就印「满100减10」；
 *   ·「巡检」而不是「日常巡检」——短，卡片不折行；
 *   ·「待作废重开」而不是「待红冲」——红冲是会计术语，而这个状态在业主退款成功后
 *     由系统自动置上（invoice.service.ts），业主必然会看到。
 *
 * 后台前端目前没有接 packages/shared（接进去要改 Vite 别名），所以三端的中文值是
 * 各自维护、由 tests/enum-labels-consistency.test.js 强制一致：该测试解析本文件、
 * 后台的映射表、小程序的 labels.js，逐 key 比对中文，不一致即失败。
 */

export const BILL_STATUS_CN: Record<string, string> = {
  DRAFT: '未发布',
  UNPAID: '待缴',
  PAID: '已缴',
  CANCELED: '已作废',
  REFUNDING: '退款中',
  REFUNDED: '已退款',
};

export const PAYMENT_STATUS_CN: Record<string, string> = {
  CREATED: '待支付',
  SUCCESS: '支付成功',
  FAILED: '支付失败',
  CLOSED: '已关闭',
  REFUNDED: '已退款',
  PREPAY_UNKNOWN: '结果待确认',
};

export const PASS_STATUS_CN: Record<string, string> = {
  ACTIVE: '有效',
  USED: '已使用',
  EXPIRED: '已过期',
  CANCELED: '已取消',
};

export const INVOICE_STATUS_CN: Record<string, string> = {
  PENDING: '待处理',
  ISSUED: '已开具',
  REJECTED: '已驳回',
  REVERSAL_REQUIRED: '待作废重开',
  REVERSED: '已作废',
};

export const USER_COUPON_STATUS_CN: Record<string, string> = {
  UNUSED: '未使用',
  USED: '已使用',
  EXPIRED: '已过期',
};

export const COUPON_TYPE_CN: Record<string, string> = {
  DISCOUNT: '满减',
  GIFT: '赠送券',
};

export const WORK_CATEGORY_CN: Record<string, string> = {
  INSPECTION: '巡检',
  CLEANING: '保洁',
  GREENING: '绿化',
  REPAIR: '维修',
  SECURITY: '安保',
  OTHER: '其他',
};

export const SERVICE_ORDER_STATUS_CN: Record<string, string> = {
  PENDING: '待接单',
  ACCEPTED: '已接单',
  DONE: '已完成',
  CANCELED: '已取消',
};

/**
 * 取中文文案；未知取值返回原值而不是空串——空串会让提示读起来像漏了一段，
 * 而原值至少能让物业照着排查。业主端渲染另有 labels.label() 的「—」兜底。
 */
export function cn(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return '';
  return map[key] ?? key;
}
