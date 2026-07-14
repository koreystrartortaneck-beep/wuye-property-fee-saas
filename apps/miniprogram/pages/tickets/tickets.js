const { request } = require('../../utils/request');

const TYPE_LABEL = { REPAIR: '报修', COMPLAINT: '投诉', SUGGESTION: '建议' };
const STATUS_LABEL = { PENDING: '待受理', PROCESSING: '处理中', DONE: '已办结', CLOSED: '已关闭' };

Page({
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
    const res = await request(`/owner/tickets?page=${page}&pageSize=20`, { silent: true });
    const mapped = (res.list || []).map((t) => ({
      id: t.id,
      typeLabel: TYPE_LABEL[t.type] || t.type,
      type: t.type,
      content: t.content || '',
      statusLabel: STATUS_LABEL[t.status] || t.status,
      status: t.status,
      houseName: t.house && t.house.community ? `${t.house.community.name} ${t.house.displayName}` : '',
      time: (t.createdAt || '').replace('T', ' ').slice(0, 16),
      rated: t.rating !== null,
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

  goDetail(e) {
    wx.navigateTo({ url: `/pages/ticket-detail/ticket-detail?id=${e.currentTarget.dataset.id}` });
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/ticket-create/ticket-create' });
  },
});
