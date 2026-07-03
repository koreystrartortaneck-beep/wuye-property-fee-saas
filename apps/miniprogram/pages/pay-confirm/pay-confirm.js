const { request } = require('../../utils/request');

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
    wx.showLoading({ title: '支付中' });
    try {
      const billIds = this.data.items.map((b) => b.id);
      const order = await request('/owner/payments', { method: 'POST', data: { billIds } });
      // mock 模式：直接确认；real 模式（子项目5）：wx.requestPayment(order.payParams)
      if (order.payParams && order.payParams.mock) {
        await request(`/owner/payments/${order.orderNo}/mock-confirm`, { method: 'POST' });
      }
      getApp().globalData.pendingBills = [];
      wx.hideLoading();
      wx.redirectTo({ url: `/pages/pay-success/pay-success?orderNo=${order.orderNo}` });
    } catch (e) {
      wx.hideLoading();
      this.setData({ paying: false });
    }
  },
});
