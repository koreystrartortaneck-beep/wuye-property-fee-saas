const { request } = require('../../utils/request');
const { requestSubscribe } = require('../../utils/subscribe');
const { waitForPaymentConfirmation } = require('../../utils/payment');

Page({
  data: {
    billId: '',
    house: '',
    title: '',
    totalAmount: '0.00',
    paused: false,
    pausedReason: '',
    payable: false,
    loaded: false,
    paying: false,
    // 幂等请求标识：同一次缴费动作的重试复用同一 requestId
    requestId: '',
  },

  onLoad(query) {
    const billId = (query && query.billId) || '';
    if (!billId) {
      wx.showToast({ title: '缺少账单信息', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    // 每次进入确认页生成一个稳定的幂等键，供重试复用
    const requestId = `pay-${billId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.setData({ billId, requestId });
    this.refreshQuote();
  },

  /** 向后端复核账单权威金额与分层收款状态，不信任本地缓存 */
  async refreshQuote() {
    try {
      const quote = await request(`/owner/payments/quote/${this.data.billId}`);
      const paused = quote.collection && quote.collection.status === 'PAUSED';
      this.setData({
        loaded: true,
        title: quote.title,
        totalAmount: Number(quote.amount).toFixed(2),
        house: quote.house ? `${quote.house.communityName} ${quote.house.displayName}` : '',
        paused,
        pausedReason: (quote.collection && quote.collection.reason) || '',
        payable: quote.payable,
      });
    } catch (e) {
      wx.showToast({ title: '账单信息获取失败', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
    }
  },

  async submitPay() {
    if (this.data.paying) return;
    if (!this.data.payable) {
      wx.showToast({ title: this.data.paused ? '当前收款已暂停' : '该账单暂不可缴费', icon: 'none' });
      return;
    }
    this.setData({ paying: true });
    // 请求订阅缴费提醒（须在点击手势上下文，故放最前、不阻断支付）
    await requestSubscribe().catch(() => {});
    wx.showLoading({ title: '支付中' });
    let order = null;
    try {
      order = await request('/owner/payments', {
        method: 'POST',
        data: { billId: this.data.billId, requestId: this.data.requestId },
      });
      if (order.payParams && order.payParams.mock) {
        // mock 模式：直接确认
        await request(`/owner/payments/${order.orderNo}/mock-confirm`, { method: 'POST' });
      } else if (order.payParams) {
        // 收银台成功不等于业务入账，必须等待支付回调或主动查单确认。
        wx.hideLoading();
        await new Promise((resolve, reject) =>
          wx.requestPayment({ ...order.payParams, success: resolve, fail: reject }),
        );
        wx.showLoading({ title: '确认支付结果' });
        const confirmed = await waitForPaymentConfirmation(order.orderNo);
        if (confirmed.status !== 'SUCCESS') {
          wx.hideLoading();
          await new Promise((resolve) => wx.showModal({
            title: '支付结果确认中',
            content: '请稍后在缴费记录中查看最终结果',
            showCancel: false,
            complete: resolve,
          }));
          this.setData({ paying: false });
          return;
        }
      } else {
        // 无 payParams（如预下单结果不确定 PREPAY_UNKNOWN）：提示稍后查看
        wx.hideLoading();
        await new Promise((resolve) => wx.showModal({
          title: '支付结果确认中',
          content: '请稍后在缴费记录中查看最终结果',
          showCancel: false,
          complete: resolve,
        }));
        this.setData({ paying: false });
        return;
      }
      wx.hideLoading();
      wx.redirectTo({ url: `/pages/pay-success/pay-success?orderNo=${order.orderNo}` });
    } catch (e) {
      wx.hideLoading();
      if (order && order.payParams && !order.payParams.mock) {
        try {
          const result = await request(`/owner/payments/${order.orderNo}/cancel`, {
            method: 'POST',
            silent: true,
          });
          if (result.status === 'SUCCESS') {
            wx.redirectTo({ url: `/pages/pay-success/pay-success?orderNo=${order.orderNo}` });
            return;
          }
          if (result.status === 'CLOSED') {
            wx.showToast({ title: '支付已取消', icon: 'none' });
          }
        } catch (_) {
          wx.showModal({
            title: '支付结果待确认',
            content: '请稍后在缴费记录中查看最终结果',
            showCancel: false,
          });
        }
      }
      this.setData({ paying: false });
    }
  },
});
