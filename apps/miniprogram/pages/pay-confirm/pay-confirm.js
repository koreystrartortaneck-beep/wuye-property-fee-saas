const { request } = require('../../utils/request');
const { requestSubscribe } = require('../../utils/subscribe');
const { waitForPaymentConfirmation } = require('../../utils/payment');

Page({
  data: {
    house: '',
    totalAmount: '0.00',
    items: [],
    paying: false,
  },

  onLoad() {
    const app = getApp();
    const pending = app.globalData.pendingBills || [];
    if (pending.length === 0) {
      wx.showToast({ title: '没有待支付的账单', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    const totalCents = pending.reduce((s, b) => s + Math.round(Number(b.amount) * 100), 0);
    this.setData({
      items: pending,
      totalAmount: (totalCents / 100).toFixed(2),
      house: app.globalData.currentHouse
        ? `${app.globalData.currentHouse.communityName} ${app.globalData.currentHouse.displayName}`
        : '',
    });
  },

  async submitPay() {
    if (this.data.paying) return;
    this.setData({ paying: true });
    // 请求订阅缴费提醒（须在点击手势上下文，故放最前、不阻断支付）
    await requestSubscribe().catch(() => {});
    wx.showLoading({ title: '支付中' });
    let order = null;
    try {
      const billIds = this.data.items.map((b) => b.id);
      order = await request('/owner/payments', { method: 'POST', data: { billIds } });
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
      }
      getApp().globalData.pendingBills = [];
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
            getApp().globalData.pendingBills = [];
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
