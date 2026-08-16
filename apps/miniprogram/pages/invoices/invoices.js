const share = require('../../utils/share');
const { request } = require('../../utils/request');
const labels = require('../../utils/labels');
const { fmtDateTime } = require('../../utils/datetime');
const STATUS_LABEL = labels.INVOICE_STATUS;
const TITLE_TYPE_LABEL = labels.INVOICE_TITLE_TYPE;



Page({
  // 转发/朋友圈:没有这两个回调,菜单里的分享是灰的(2026-08-15 实测)
  onShareAppMessage: share.onShareAppMessage,
  onShareTimeline: share.onShareTimeline,

  data: {
    list: [],
    loading: true,
    error: false,
  },

  async onShow() {
    await this.load();
  },

  async load() {
    this.setData({ loading: true, error: false });
    try {
      await getApp().loginReady;
      const list = await request('/owner/invoices', { silent: true });
      this.setData({
        loading: false,
        error: false,
        list: (list || []).map((a) => ({
          id: a.id,
          applicationNo: a.applicationNo,
          statusLabel: STATUS_LABEL[a.status] || a.status,
          issued: a.status === 'ISSUED',
          titleTypeLabel: TITLE_TYPE_LABEL[a.titleType] || a.titleType,
          title: a.title,
          amount: Number(a.amount || 0).toFixed(2),
          invoiceNo: a.invoiceNo || '',
          time: fmtDateTime(a.appliedAt),
        })),
      });
    } catch (e) {
      this.setData({ loading: false, error: true });
    }
  },

  retry() {
    this.load();
  },

  async onPullDownRefresh() {
    try {
      await this.load();
    } finally {
      wx.stopPullDownRefresh();
    }
  },
});
