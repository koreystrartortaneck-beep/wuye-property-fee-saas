const share = require('../../utils/share');
const { request } = require('../../utils/request');
const { canApplyInvoice } = require('../../utils/invoice');
const labels = require('../../utils/labels');
const { fmtDateTime } = require('../../utils/datetime');
const STATUS_LABEL = labels.PAYMENT_STATUS;


Page({
  // 转发/朋友圈:没有这两个回调,菜单里的分享是灰的(2026-08-15 实测)
  onShareAppMessage: share.onShareAppMessage,
  onShareTimeline: share.onShareTimeline,

  data: {
    list: [],
    page: 1,
    total: 0,
    loadingMore: false,
    loading: true,
    error: false,
  },

  async onShow() {
    await this.load();
  },

  async load() {
    this.setData({ loading: true, error: false, page: 1 });
    try {
      await getApp().loginReady;
      await this.fetchPage(1);
      this.setData({ loading: false, error: false });
    } catch (e) {
      if (this.data.list.length === 0) {
        this.setData({ error: true, loading: false });
      } else {
        this.setData({ loading: false, error: false });
      }
    }
  },

  retry() {
    this.load();
  },

  async fetchPage(page) {
    const res = await request(`/owner/payments?page=${page}&pageSize=20`, { silent: true });
    const mapped = (res.list || []).map((p) => ({
      orderNo: p.orderNo,
      totalAmount: Number(p.totalAmount).toFixed(2),
      statusLabel: STATUS_LABEL[p.status] || p.status,
      success: p.status === 'SUCCESS',
      refunded: p.status === 'REFUNDED',
      // 开票资格完全由订单状态派生：仅成功且未退款订单可开票
      canInvoice: canApplyInvoice(p),
      time: fmtDateTime(p.paidAt || p.createdAt),
      billTitles: (p.bills || []).map((b) => b.title).join(' · '),
    }));
    this.setData({
      list: page === 1 ? mapped : this.data.list.concat(mapped),
      total: res.total || 0,
      page,
    });
  },

  async onReachBottom() {
    if (this.data.list.length >= this.data.total || this.data.loadingMore) return;
    this.setData({ loadingMore: true });
    try {
      await this.fetchPage(this.data.page + 1);
    } finally {
      this.setData({ loadingMore: false });
    }
  },

  async onPullDownRefresh() {
    try {
      await this.load();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  /** 支付成功的订单 → 电子收据 */
  goReceipt(e) {
    const item = this.data.list[Number(e.currentTarget.dataset.index)];
    if (!item || !item.success) return;
    wx.navigateTo({ url: `/pages/receipt/receipt?orderNo=${item.orderNo}` });
  },

  /** 成功且未退款订单 → 申请开票 */
  goInvoice(e) {
    const item = this.data.list[Number(e.currentTarget.dataset.index)];
    if (!item || !item.canInvoice) return;
    wx.navigateTo({ url: `/pages/invoice-apply/invoice-apply?orderNo=${item.orderNo}` });
  },

  /** 我的开票记录 */
  goInvoices() {
    wx.navigateTo({ url: '/pages/invoices/invoices' });
  },
});
