const { request } = require('../../utils/request');
const { imageUrl } = require('../../utils/upload');

const CATEGORY_LABEL = { INSPECTION: '日常巡检', CLEANING: '保洁', GREENING: '绿化', SECURITY: '安保', REPAIR: '维修', OTHER: '其他' };

Page({
  data: { log: null },

  async onLoad(options) {
    await getApp().loginReady;
    const w = await request(`/owner/work-logs/${options.id}`);
    this.setData({
      log: {
        category: CATEGORY_LABEL[w.category] || w.category,
        title: w.title || CATEGORY_LABEL[w.category],
        description: w.description || '',
        images: (w.images || []).map(imageUrl),
        staffName: w.staffName || '',
        time: (w.createdAt || '').replace('T', ' ').slice(0, 16),
      },
    });
  },

  preview(e) {
    wx.previewImage({ current: e.currentTarget.dataset.src, urls: this.data.log.images });
  },
});
