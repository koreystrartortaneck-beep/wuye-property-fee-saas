const { request } = require('../../utils/request');

const STATUS_LABEL = {
  SUBMITTED: '已提交',
  PROCESSING: '处理中',
  ISSUED: '已开具',
  REJECTED: '已驳回',
  CANCELED: '已取消',
  REVERSAL_REQUIRED: '待红冲',
  REVERSED: '已红冲',
};

const TITLE_TYPE_LABEL = { PERSONAL: '个人', ENTERPRISE: '企业' };

Page({
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
          time: (a.appliedAt || '').replace('T', ' ').slice(0, 16),
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
