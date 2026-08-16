const share = require('../../utils/share');
const { request } = require('../../utils/request');
const { fmtDateTime } = require('../../utils/datetime');

Page({
  // 转发/朋友圈:没有这两个回调,菜单里的分享是灰的(2026-08-15 实测)
  onShareAppMessage: share.onShareAppMessage,
  onShareTimeline: share.onShareTimeline,

  data: { ann: null, loading: true, error: false },

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
      const a = await request(`/owner/announcements/${this.id}`, { silent: true });
      this.setData({
        loading: false,
        error: false,
        ann: {
          title: a.title || '',
          content: a.content || '',
          date: fmtDateTime(a.publishedAt),
        },
      });
    } catch (e) {
      this.setData({ loading: false, error: true });
    }
  },
});
