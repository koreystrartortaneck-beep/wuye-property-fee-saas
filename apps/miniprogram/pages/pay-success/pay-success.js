const { request } = require('../../utils/request');
const { canApplyInvoice } = require('../../utils/invoice');

Page({
  data: {
    amount: '',
    orderNo: '',
    payTime: '',
    house: '',
    canInvoice: false,
  },

  async onLoad(options) {
    const app = getApp();
    // 先用当前房屋兜底，拿到订单后以订单房屋为准
    this.setData({
      house: app.globalData.currentHouse
        ? `${app.globalData.currentHouse.communityName} ${app.globalData.currentHouse.displayName}`
        : '',
    });
    if (!options.orderNo) return;
    try {
      const order = await request(`/owner/payments/${options.orderNo}`, { silent: true });
      this.setData({
        orderNo: order.orderNo || '',
        amount: Number(order.totalAmount || 0).toFixed(2),
        payTime: order.paidAt ? order.paidAt.replace('T', ' ').slice(0, 16) : '',
        house: order.house
          ? `${order.house.communityName || ''} ${order.house.displayName || ''}`.trim()
          : this.data.house,
        // 开票资格由后端订单状态派生
        canInvoice: canApplyInvoice(order),
      });
    } catch (e) {
      // 拉单失败不影响"缴费成功"结论，凭证字段留空即可
    }
  },

  goInvoice() {
    if (!this.data.orderNo || !this.data.canInvoice) return;
    wx.navigateTo({ url: `/pages/invoice-apply/invoice-apply?orderNo=${this.data.orderNo}` });
  },

  backHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  viewBill() {
    wx.switchTab({ url: '/pages/bill/bill' });
  },

  viewReceipt() {
    if (!this.data.orderNo) return;
    wx.navigateTo({ url: `/pages/receipt/receipt?orderNo=${this.data.orderNo}` });
  },
});
