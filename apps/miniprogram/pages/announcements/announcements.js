const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');

Page({
  data: { list: [] },

  async onShow() {
    await getApp().loginReady;
    await loadMyHouses().catch(() => []);
    const house = getApp().globalData.currentHouse;
    if (!house) {
      this.setData({ list: [] });
      return;
    }
    const list = await request(`/owner/announcements?houseId=${house.houseId}`);
    this.setData({
      list: list.map((a) => ({
        id: a.id,
        title: a.title,
        preview: a.content.slice(0, 60),
        pinned: a.pinned,
        date: (a.publishedAt || '').slice(0, 10),
      })),
    });
  },

  async onPullDownRefresh() {
    try {
      await this.onShow();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/announcement-detail/announcement-detail?id=${e.currentTarget.dataset.id}` });
  },
});
