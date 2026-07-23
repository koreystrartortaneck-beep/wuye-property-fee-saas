/**
 * 财务工作台纯逻辑（标签、状态色、幂等键、金额格式化、下单载荷构造）。
 * 抽出为无依赖模块以便单测，视图仅做展示与交互。所有金额均为「元」字符串，
 * 所有涉及资金/状态变更的接口都要携带 requestId 幂等键；退款不接收前端金额。
 */

export const BILL_STATUS_LABEL: Record<string, string> = {
  UNPAID: '待缴',
  PAID: '已缴',
  CANCELED: '已作废',
  DRAFT: '草稿',
  REFUNDING: '退款中',
  REFUNDED: '已退款',
};

export const BILL_BATCH_STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  GENERATING: '生成中',
  READY: '待发布',
  PUBLISHED: '已发布',
  FAILED: '失败',
  CANCELED: '已取消',
};

export const BILL_SOURCE_LABEL: Record<string, string> = { RULE: '规则出账', IMPORT: '导入' };

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  CREATED: '待支付',
  SUCCESS: '支付成功',
  FAILED: '支付失败',
  CLOSED: '已关闭',
  REFUNDED: '已退款',
  PREPAY_UNKNOWN: '结果待确认',
};

export const PAYMENT_CHANNEL_LABEL: Record<string, string> = { MOCK: '模拟', WXPAY: '微信支付', OFFLINE: '线下' };

export const REFUND_STATUS_LABEL: Record<string, string> = {
  CREATED: '已创建',
  PROCESSING: '处理中',
  SUCCESS: '退款成功',
  FAILED: '退款失败',
  CLOSED: '已关闭',
  ABNORMAL: '异常待查',
};

export const RECON_RUN_STATUS_LABEL: Record<string, string> = { RUNNING: '进行中', COMPLETED: '已完成', FAILED: '失败' };

export const RECON_BILL_TYPE_LABEL: Record<string, string> = { TRANSACTION: '交易账单', REFUND: '退款账单' };

export const RECON_DIFF_LABEL: Record<string, string> = {
  CHANNEL_MISSING: '渠道缺失',
  LOCAL_MISSING: '本地缺失',
  AMOUNT_MISMATCH: '金额不一致',
  STATUS_MISMATCH: '状态不一致',
  REFUND_MISMATCH: '退款不一致',
};

export const RECON_ITEM_STATUS_LABEL: Record<string, string> = {
  OPEN: '待处理',
  AUTO_RESOLVED: '自动核销',
  MANUALLY_CLOSED: '人工关闭',
  ESCALATED: '已升级',
};

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  SUBMITTED: '已提交',
  PROCESSING: '处理中',
  ISSUED: '已开具',
  REJECTED: '已驳回',
  CANCELED: '已取消',
  REVERSAL_REQUIRED: '需红冲',
  REVERSED: '已红冲',
};

export const INVOICE_TITLE_TYPE_LABEL: Record<string, string> = { PERSONAL: '个人', ENTERPRISE: '企业' };

export const COLLECTION_STATUS_LABEL: Record<string, string> = { OPEN: '正常收款', PAUSED: '已暂停' };

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  CREATE: '创建',
  UPDATE: '更新',
  PUBLISH: '发布',
  CANCEL: '作废',
  PAY: '支付',
  REFUND: '退款',
  RECONCILE: '对账',
  INVOICE: '开票',
  RECOVER: '恢复',
};

export const AUDIT_ACTOR_LABEL: Record<string, string> = { SYSTEM: '系统', ADMIN: '管理员', WX_USER: '业主' };

type TagType = 'success' | 'warning' | 'info' | 'danger' | '';

export function billStatusTag(s: string): TagType {
  if (s === 'PAID') return 'success';
  if (s === 'UNPAID') return 'warning';
  if (s === 'REFUNDING') return 'warning';
  return 'info';
}

export function paymentStatusTag(s: string): TagType {
  if (s === 'SUCCESS') return 'success';
  if (s === 'FAILED') return 'danger';
  if (s === 'CREATED' || s === 'PREPAY_UNKNOWN') return 'warning';
  return 'info';
}

export function refundStatusTag(s: string): TagType {
  if (s === 'SUCCESS') return 'success';
  if (s === 'FAILED' || s === 'ABNORMAL') return 'danger';
  if (s === 'CREATED' || s === 'PROCESSING') return 'warning';
  return 'info';
}

export function reconRunStatusTag(s: string): TagType {
  if (s === 'COMPLETED') return 'success';
  if (s === 'FAILED') return 'danger';
  return 'warning';
}

export function reconItemStatusTag(s: string): TagType {
  if (s === 'AUTO_RESOLVED' || s === 'MANUALLY_CLOSED') return 'success';
  if (s === 'ESCALATED') return 'danger';
  return 'danger';
}

export function invoiceStatusTag(s: string): TagType {
  if (s === 'ISSUED') return 'success';
  if (s === 'REJECTED') return 'danger';
  if (s === 'REVERSAL_REQUIRED' || s === 'REVERSED') return 'warning';
  if (s === 'CANCELED') return 'info';
  return 'warning';
}

/** 稳定幂等键：同一用户动作重试复用同一个 requestId（由调用方持有）。 */
export function genRequestId(prefix = 'op'): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${rand}`;
}

/** 金额（分或元字符串/数字）统一渲染为两位小数元；后端已给「元」。 */
export function yuan(v: unknown): string {
  const n = Number(v ?? 0);
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

/** 日期时间截断显示 YYYY-MM-DD HH:mm。 */
export function dt(v: unknown): string {
  if (!v) return '—';
  return String(v).replace('T', ' ').slice(0, 16);
}

export function day(v: unknown): string {
  if (!v) return '—';
  return String(v).slice(0, 10);
}

export interface RefundPayload {
  orderNo: string;
  reason: string;
  requestId: string;
}

/** 退款载荷：只传订单号 + 原因 + 幂等键，绝不接收前端金额（后端按订单全额退）。 */
export function buildRefundPayload(orderNo: string, reason: string, requestId?: string): RefundPayload {
  const r = (reason ?? '').trim();
  if (!r) throw new Error('请填写退款原因');
  return { orderNo, reason: r, requestId: requestId || genRequestId('refund') };
}

export interface ReasonPayload {
  reason: string;
  requestId: string;
}

/** 作废/重开/冲正等破坏性操作：强制原因 + 幂等键。 */
export function buildReasonPayload(reason: string, requestId?: string): ReasonPayload {
  const r = (reason ?? '').trim();
  if (!r) throw new Error('请填写操作原因');
  return { reason: r, requestId: requestId || genRequestId('op') };
}

export interface OfflineForm {
  billId: string;
  voucherNo: string;
  paidAt: string;
  payerName?: string;
  remark?: string;
}

export interface OfflinePayload {
  billId: string;
  voucherNo: string;
  paidAt: string;
  payerName?: string;
  remark?: string;
  requestId: string;
}

/** 线下核销载荷：账单、凭证号、缴费时间必填。 */
export function buildOfflinePayload(form: OfflineForm, requestId?: string): OfflinePayload {
  if (!form.billId) throw new Error('请填写账单 ID');
  if (!(form.voucherNo ?? '').trim()) throw new Error('请填写凭证号');
  if (!form.paidAt) throw new Error('请填写缴费时间');
  return {
    billId: form.billId,
    voucherNo: form.voucherNo.trim(),
    paidAt: new Date(form.paidAt).toISOString(),
    ...(form.payerName ? { payerName: form.payerName } : {}),
    ...(form.remark ? { remark: form.remark } : {}),
    requestId: requestId || genRequestId('offline'),
  };
}
