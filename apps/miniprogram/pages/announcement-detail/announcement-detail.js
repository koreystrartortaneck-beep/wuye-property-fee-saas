const { request } = require('../../utils/request');

Page({
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
          date: (a.publishedAt || '').replace('T', ' ').slice(0, 16),
        },
      });
    } catch (e) {
      this.setData({ loading: false, error: true });
    }
  },
});
