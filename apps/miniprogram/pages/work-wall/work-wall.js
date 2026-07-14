const { request } = require('../../utils/request');
const { imageUrl } = require('../../utils/upload');
const { loadMyHouses } = require('../../utils/auth');

const CATEGORY_LABEL = { INSPECTION: '巡检', CLEANING: '保洁', GREENING: '绿化', SECURITY: '安保', REPAIR: '维修', OTHER: '其他' };
const FILTERS = [
  { value: '', label: '全部' },
  { value: 'INSPECTION', label: '巡检' },
  { value: 'CLEANING', label: '保洁' },
  { value: 'SECURITY', label: '安保' },
  { value: 'GREENING', label: '绿化' },
  { value: 'REPAIR', label: '维修' },
];

Page({
  data: {
    filters: FILTERS,
    activeCat: '',
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
      await loadMyHouses().catch(() => []);
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
    const house = getApp().globalData.currentHouse;
    if (!house) {
      this.setData({ list: [] });
      return;
    }
    const cat = this.data.activeCat;
    const res = await request(`/owner/work-logs?houseId=${house.houseId}&page=${page}&pageSize=20${cat ? '&category=' + cat : ''}`, { silent: true });
    const mapped = (res.list || []).map((w) => ({
      id: w.id,
      category: CATEGORY_LABEL[w.category] || w.category,
      title: w.title || CATEGORY_LABEL[w.category],
      desc: w.description || '',
      cover: imageUrl((w.images || [])[0]),
      count: (w.images || []).length,
      staffName: w.staffName || '',
      time: (w.createdAt || '').replace('T', ' ').slice(0, 16),
    }));
    this.setData({
      list: page === 1 ? mapped : this.data.list.concat(mapped),
      total: res.total || 0,
      page,
    });
  },

  async setCat(e) {
    this.setData({ activeCat: e.currentTarget.dataset.cat });
    await this.load();
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
    wx.navigateTo({ url: `/pages/work-detail/work-detail?id=${e.currentTarget.dataset.id}` });
  },
});
