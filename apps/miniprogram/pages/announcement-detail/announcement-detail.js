const { request } = require('../../utils/request');

Page({
  data: { ann: null },

  async onLoad(options) {
    await getApp().loginReady;
    const a = await request(`/owner/announcements/${options.id}`);
    this.setData({
      ann: {
        title: a.title,
        content: a.content,
        date: (a.publishedAt || '').replace('T', ' ').slice(0, 16),
      },
    });
  },
});
