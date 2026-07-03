const { request } = require('../../utils/request');

Page({
  data: {
    amount: '',
    orderNo: '',
    payTime: '',
    house: '',
  },

  async onLoad(options) {
    const app = getApp();
    this.setData({
      house: app.globalData.currentHouse
        ? `${app.globalData.currentHouse.communityName} ${app.globalData.currentHouse.displayName}`
        : '',
    });
    if (!options.orderNo) return;
    const order = await request(`/owner/payments/${options.orderNo}`);
    this.setData({
      orderNo: order.orderNo,
      amount: Number(order.totalAmount).toFixed(2),
      payTime: order.paidAt ? order.paidAt.replace('T', ' ').slice(0, 16) : '',
    });
  },

  backHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  viewBill() {
    wx.switchTab({ url: '/pages/bill/bill' });
  },
});
