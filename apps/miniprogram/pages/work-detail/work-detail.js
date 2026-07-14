const { request } = require('../../utils/request');
const { imageUrl } = require('../../utils/upload');

const CATEGORY_LABEL = { INSPECTION: '日常巡检', CLEANING: '保洁', GREENING: '绿化', SECURITY: '安保', REPAIR: '维修', OTHER: '其他' };

Page({
  data: { log: null, loading: true, error: false },

  onLoad(options) {
    this.id = options.id;
    this.load();
  },

  retry() {
    this.load();
  },

  async load() {
    if (!this.id) {
      this.setData({ loading: false, error: true });
      return;
    }
    this.setData({ loading: true, error: false });
    try {
      await getApp().loginReady;
      const w = await request(`/owner/work-logs/${this.id}`, { silent: true });
      this.setData({
        loading: false,
        error: false,
        log: {
          category: CATEGORY_LABEL[w.category] || w.category,
          title: w.title || CATEGORY_LABEL[w.category] || '物业工作',
          description: w.description || '',
          images: (w.images || []).map(imageUrl),
          staffName: w.staffName || '',
          time: (w.createdAt || '').replace('T', ' ').slice(0, 16),
        },
      });
    } catch (e) {
      this.setData({ loading: false, error: true });
    }
  },

  preview(e) {
    wx.previewImage({ current: e.currentTarget.dataset.src, urls: this.data.log.images });
  },
});
