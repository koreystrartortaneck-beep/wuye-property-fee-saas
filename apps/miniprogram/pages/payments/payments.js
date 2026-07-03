const { request } = require('../../utils/request');

const STATUS_LABEL = {
  CREATED: '待支付',
  SUCCESS: '支付成功',
  FAILED: '支付失败',
  CLOSED: '已关闭',
  REFUNDED: '已退款',
};

Page({
  data: {
    list: [],
    page: 1,
    total: 0,
    loadingMore: false,
  },

  async onShow() {
    await getApp().loginReady;
    this.setData({ page: 1, list: [] });
    await this.fetchPage(1);
  },

  async fetchPage(page) {
    const res = await request(`/owner/payments?page=${page}&pageSize=20`);
    const mapped = res.list.map((p) => ({
      orderNo: p.orderNo,
      totalAmount: Number(p.totalAmount).toFixed(2),
      statusLabel: STATUS_LABEL[p.status] || p.status,
      success: p.status === 'SUCCESS',
      time: (p.paidAt || p.createdAt || '').replace('T', ' ').slice(0, 16),
      billTitles: p.bills.map((b) => b.title).join(' · '),
    }));
    this.setData({
      list: page === 1 ? mapped : this.data.list.concat(mapped),
      total: res.total,
      page,
    });
  },

  async onReachBottom() {
    if (this.data.list.length >= this.data.total || this.data.loadingMore) return;
    this.setData({ loadingMore: true });
    await this.fetchPage(this.data.page + 1);
    this.setData({ loadingMore: false });
  },

  async onPullDownRefresh() {
    try {
      this.setData({ page: 1, list: [] });
      await this.fetchPage(1);
    } finally {
      wx.stopPullDownRefresh();
    }
  },
});
