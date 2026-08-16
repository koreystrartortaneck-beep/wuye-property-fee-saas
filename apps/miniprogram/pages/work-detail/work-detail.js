const share = require('../../utils/share');
const { request } = require('../../utils/request');
const { imageUrl } = require('../../utils/upload');
const { fmtDateTime } = require('../../utils/datetime');
const { WORK_CATEGORY } = require('../../utils/labels');

// 分类文案的单一真源在 utils/labels.js。原先 4 个页面各写一份且互相矛盾：
// OTHER 一半是「公示」一半是「其他」，INSPECTION 一半是「巡检」一半是「日常巡检」，
// 业主在列表看到「巡检」点进详情会变成「日常巡检」。
const CATEGORY_LABEL = WORK_CATEGORY;

Page({
  // 转发/朋友圈:没有这两个回调,菜单里的分享是灰的(2026-08-15 实测)
  onShareAppMessage: share.onShareAppMessage,
  onShareTimeline: share.onShareTimeline,

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
          time: fmtDateTime(w.createdAt),
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
