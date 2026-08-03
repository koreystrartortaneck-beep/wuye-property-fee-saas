/**
 * 枚举中文文案：单一真源。
 *
 * 教训：账单列表页与详情页各写一份 STATUS_LABEL，列表页补了 REFUNDED
 * 详情页却没补，导致业主直接看到英文「REFUNDED」。凡展示后端枚举，
 * 一律从这里取，并由 tests/miniprogram-labels.test.js 自动比对
 * packages/shared/src/enums.ts，缺项即测试失败。
 */

/** 账单状态。DRAFT 后端已对业主过滤，此处仍给文案以防兜底显示英文。 */
const BILL_STATUS = {
  DRAFT: '未发布',
  UNPAID: '待缴',
  PAID: '已缴',
  CANCELED: '已作废',
  REFUNDING: '退款中',
  REFUNDED: '已退款',
};

/** 支付订单状态 */
const PAYMENT_STATUS = {
  CREATED: '待支付',
  SUCCESS: '支付成功',
  FAILED: '支付失败',
  CLOSED: '已关闭',
  REFUNDED: '已退款',
  PREPAY_UNKNOWN: '结果待确认',
};

/** 开票申请状态 */
const INVOICE_STATUS = {
  SUBMITTED: '已提交',
  PROCESSING: '处理中',
  ISSUED: '已开具',
  REJECTED: '已驳回',
  CANCELED: '已取消',
  REVERSAL_REQUIRED: '待作废重开',
  REVERSED: '已作废',
};

/** 发票抬头类型 */
const INVOICE_TITLE_TYPE = { PERSONAL: '个人', ENTERPRISE: '企业' };

/** 工单 */
const TICKET_TYPE = { REPAIR: '报修', COMPLAINT: '投诉', SUGGESTION: '建议' };
const TICKET_STATUS = { PENDING: '待受理', PROCESSING: '处理中', DONE: '已办结', CLOSED: '已关闭' };

/** 访客通行码 */
const PASS_STATUS = { ACTIVE: '有效', USED: '已使用', EXPIRED: '已过期', CANCELED: '已取消' };

/**
 * 生活服务订单。
 * PENDING 取「待接单」而不是「待受理」：与工单的 TICKET_STATUS.PENDING（待受理）
 * 区分开是对的——物业接单 ≠ 受理工单，是两件事。原先本表写「待受理」而 services.js
 * 自建的表写「待接单」，且页面用的是后者，本表形同虚设。
 */
const SERVICE_ORDER_STATUS = { PENDING: '待接单', ACCEPTED: '已接单', DONE: '已完成', CANCELED: '已取消' };

/** 优惠券 */
const COUPON_TYPE = { DISCOUNT: '满减', SERVICE: '服务券', GIFT: '礼品券' };
// USED 取「已使用」：核销是财务术语，且本文件上方 PASS_STATUS.USED 就是「已使用」,
// 同一个 key 在同一个文件里两种译法是原先的状态。
const USER_COUPON_STATUS = { UNUSED: '未使用', USED: '已使用', EXPIRED: '已过期' };

/**
 * 物业工作分类（工作照片墙 / 首页动态 / 社区页 / 详情页共用）。
 *
 * 原先在 4 个页面各写一份，且互相矛盾：index.js 与 community.js 的 OTHER 是
 * 「公示」，work-wall.js 与 work-detail.js 是「其他」；INSPECTION 在 work-detail.js
 * 是「日常巡检」、其余是「巡检」。于是业主在列表看到「巡检」，点进详情变成
 * 「日常巡检」——一次点击之内换了名字。
 *
 * OTHER 取「其他」：「公示」是载体名（物业公示）而不是分类名，把它当分类会和
 * 页面标题重复。INSPECTION 取「巡检」：短，卡片不折行。
 */
const WORK_CATEGORY = {
  INSPECTION: '巡检',
  CLEANING: '保洁',
  GREENING: '绿化',
  REPAIR: '维修',
  SECURITY: '安保',
  OTHER: '其他',
};

/** 绑定关系 / 来源 / 状态 */
const BINDING_RELATION = { OWNER: '业主', FAMILY: '家属', TENANT: '租客' };
const BINDING_SOURCE = { PHONE_MATCH: '手机号匹配', APPLY: '自助申请' };
const BINDING_STATUS = { PENDING: '待审核', ACTIVE: '已通过', REJECTED: '已驳回' };

/** 计量与分摊 */
const METER_TYPE = { WATER: '水表', ELEC: '电表', GAS: '燃气表' };
const SHARE_BY = { AREA: '按面积分摊', HOUSE: '按户均分' };
const HOUSE_TYPE = { RESIDENCE: '住宅', PARKING: '车位', SHOP: '商铺' };

/**
 * 取文案。找不到时返回占位符而非英文枚举——
 * 宁可显示「—」也不要把内部代码暴露给业主。
 */
function label(map, key, fallback = '—') {
  if (key === null || key === undefined || key === '') return fallback;
  return map[key] || fallback;
}

module.exports = {
  WORK_CATEGORY,
  BILL_STATUS,
  PAYMENT_STATUS,
  INVOICE_STATUS,
  INVOICE_TITLE_TYPE,
  TICKET_TYPE,
  TICKET_STATUS,
  PASS_STATUS,
  SERVICE_ORDER_STATUS,
  COUPON_TYPE,
  USER_COUPON_STATUS,
  BINDING_RELATION,
  BINDING_SOURCE,
  BINDING_STATUS,
  METER_TYPE,
  SHARE_BY,
  HOUSE_TYPE,
  label,
};

/**
 * 账期标签 → 人话。
 *
 * 四种格式并存(都按字典序可排,后端约定):
 *   '2026-07'      → 「2026-07」   (legacy 月度)
 *   '2026-Q3'      → 「2026-Q3」   (legacy 季度)
 *   '2026'         → 「2026 年」   (legacy 年度)
 *   '2026-03-15'   → 「2026 年度」 (按户周年:每户各自的年度起始日)
 *
 * 周年标签在**列表**里只显示年度 —— 完整起止(2026-03-15 ~ 2027-03-14)
 * 放详情页。18 个字符塞进列表分组头的 flex 行会把右侧小计挤掉行,
 * 这类挤压之前已经咬过三次。
 */
function periodLabel(period) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(period || '')) return `${period.slice(0, 4)} 年度`;
  if (/^\d{4}$/.test(period || '')) return `${period} 年`;
  return period || '';
}

module.exports.periodLabel = periodLabel;
