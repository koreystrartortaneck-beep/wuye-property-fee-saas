const { request } = require('../../utils/request');
const { canApplyInvoice } = require('../../utils/invoice');
const { fmtDateTime } = require('../../utils/datetime');
const { waitForPaymentConfirmation } = require('../../utils/payment');

Page({
  data: {
    amount: '',
    orderNo: '',
    payTime: '',
    house: '',
    canInvoice: false,
    /*
     * 入账是否已完成。微信扣款成功与账单销账是两件事，中间通常几秒。
     * 未完成时页面照旧说「缴费成功」（那是事实），但不谎称「已实时入账」，
     * 凭证与收据入口也先不点亮 —— 它们要等入账才存在。
     */
    settled: false,
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
    this.orderNo = options.orderNo;
    const order = await this.fetchOrder();
    /*
     * 还没入账就在后台安静地推进：查单会让入账尽快发生，回来后刷新本页。
     *
     * 刻意不显示 loading、不弹框：业主的支付已经完成，剩下的是我们的记账。
     * 原来这段等待发生在上一页（转圈 + 弹框），业主付完款要先过两道解释才看到结果。
     */
    if (order && !this.data.settled) this.pollSettlement();
  },

  onUnload() {
    // 页面已经离开就别再刷了：setData 到已销毁的页面会报错，也白耗请求
    this.left = true;
  },

  async fetchOrder() {
    try {
      const order = await request(`/owner/payments/${this.orderNo}`, { silent: true });
      if (this.left) return order;
      this.setData({
        orderNo: order.orderNo || '',
        amount: Number(order.totalAmount || 0).toFixed(2),
        payTime: fmtDateTime(order.paidAt),
        house: order.house
          ? `${order.house.communityName || ''} ${order.house.displayName || ''}`.trim()
          : this.data.house,
        // 开票资格由后端订单状态派生
        canInvoice: canApplyInvoice(order),
        settled: order.status === 'SUCCESS',
      });
      return order;
    } catch (e) {
      // 拉单失败不影响「缴费成功」结论，凭证字段留空即可
      return null;
    }
  },

  async pollSettlement() {
    try {
      await waitForPaymentConfirmation(this.orderNo);
    } catch (e) {
      // 终态失败（已关闭/失败）也要刷新一次，让页面显示真实状态而不是停在「同步中」
    }
    if (this.left) return;
    await this.fetchOrder();
  },

  goInvoice() {
    if (!this.data.orderNo || !this.data.canInvoice) return;
    wx.navigateTo({ url: `/pages/invoice-apply/invoice-apply?orderNo=${this.data.orderNo}` });
  },

  backHome() {
    /*
     * 这里曾以「刚缴完费是最愿意接收提醒的时刻」为由请求订阅授权。已删：
     * 几秒前的缴费确认页已经问过一次，同一个流程里问两遍就是纯粹的骚扰。
     */
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
