/**
 * 开票申请纯逻辑：资格判定与载荷构造。抽出以便单测，页面仅做交互。
 * 契约与后端 owner/invoices 一致：{ orderNo, titleType, title, taxNo?, deliveryMethod, email?, requestId }。
 * 本系统仅登记开票申请，不代开增值税发票。
 */

const TITLE_TYPES = ['PERSONAL', 'ENTERPRISE'];

/** 仅支付成功且未退款的订单可申请开票（退款订单收据作废，不可开票）。 */
function canApplyInvoice(order) {
  return !!order && order.status === 'SUCCESS';
}

/** 构造开票载荷；抬头必填，企业抬头必须带税号；requestId 缺省时生成稳定幂等键。 */
function buildInvoicePayload(form) {
  form = form || {};
  const title = String(form.title || '').trim();
  if (!title) throw new Error('请填写发票抬头');
  const titleType = TITLE_TYPES.includes(form.titleType) ? form.titleType : 'PERSONAL';
  const taxNo = String(form.taxNo || '').trim();
  if (titleType === 'ENTERPRISE' && !taxNo) throw new Error('企业抬头需填写纳税人识别号');
  const deliveryMethod = String(form.deliveryMethod || 'EMAIL').trim();
  const requestId = form.requestId || `inv-${form.orderNo}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const payload = { orderNo: form.orderNo, titleType, title, deliveryMethod, requestId };
  if (titleType === 'ENTERPRISE') payload.taxNo = taxNo;
  const email = String(form.email || '').trim();
  if (email) payload.email = email;
  return payload;
}

module.exports = { canApplyInvoice, buildInvoicePayload };
