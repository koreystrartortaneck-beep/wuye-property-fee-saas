const { request } = require('../../utils/request');

Page({
  data: { r: null },

  async onLoad(options) {
    await getApp().loginReady;
    const p = await request(`/owner/payments/${options.orderNo}`);
    const app = getApp();
    this.setData({
      r: {
        orderNo: p.orderNo,
        totalAmount: Number(p.totalAmount).toFixed(2),
        paidAt: p.paidAt ? p.paidAt.replace('T', ' ').slice(0, 19) : '',
        houseName: app.globalData.currentHouse
          ? `${app.globalData.currentHouse.communityName} ${app.globalData.currentHouse.displayName}`
          : '',
        items: (p.bills || []).map((b) => ({
          title: b.title,
          amount: Number(b.amount).toFixed(2),
        })),
        success: p.status === 'SUCCESS',
      },
    });
  },
});
