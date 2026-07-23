const { request } = require('../../utils/request');
const { canApplyInvoice, buildInvoicePayload } = require('../../utils/invoice');

Page({
  data: {
    orderNo: '',
    amount: '',
    loaded: false,
    eligible: false,
    titleType: 'PERSONAL', // PERSONAL | ENTERPRISE
    title: '',
    taxNo: '',
    email: '',
    submitting: false,
    requestId: '',
  },

  async onLoad(options) {
    const orderNo = (options && options.orderNo) || '';
    if (!orderNo) {
      wx.showToast({ title: '缺少订单信息', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    // 稳定幂等键：同一次开票动作重试复用
    this.setData({ orderNo, requestId: `inv-${orderNo}-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    try {
      await getApp().loginReady;
      const order = await request(`/owner/payments/${orderNo}`, { silent: true });
      const eligible = canApplyInvoice(order);
      this.setData({
        loaded: true,
        eligible,
        amount: Number(order.totalAmount || 0).toFixed(2),
      });
      if (!eligible) {
        wx.showModal({
          title: '暂不可开票',
          content: '仅支付成功且未退款的订单可申请开票。',
          showCancel: false,
          complete: () => wx.navigateBack(),
        });
      }
    } catch (e) {
      this.setData({ loaded: true, eligible: false });
      wx.showToast({ title: '订单信息获取失败', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
    }
  },

  setTitleType(e) {
    this.setData({ titleType: e.currentTarget.dataset.type });
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  async submit() {
    if (this.data.submitting || !this.data.eligible) return;
    let payload;
    try {
      payload = buildInvoicePayload({
        orderNo: this.data.orderNo,
        titleType: this.data.titleType,
        title: this.data.title,
        taxNo: this.data.taxNo,
        deliveryMethod: 'EMAIL',
        email: this.data.email,
        requestId: this.data.requestId,
      });
    } catch (err) {
      wx.showToast({ title: err.message || '请完善开票信息', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await request('/owner/invoices', { method: 'POST', data: payload });
      wx.showToast({ title: '开票申请已提交', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: '/pages/invoices/invoices' }), 800);
    } catch (e) {
      // request 已统一 toast
    } finally {
      this.setData({ submitting: false });
    }
  },
});
