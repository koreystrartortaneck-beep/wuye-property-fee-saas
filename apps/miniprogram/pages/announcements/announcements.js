const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');

Page({
  data: { list: [], loading: true, error: false },

  async onShow() {
    await this.load();
  },

  async load() {
    this.setData({ loading: true, error: false });
    try {
      await getApp().loginReady;
      await loadMyHouses().catch(() => []);
      const house = getApp().globalData.currentHouse;
      if (!house) {
        this.setData({ list: [], loading: false, error: false });
        return;
      }
      const list = await request(`/owner/announcements?houseId=${house.houseId}`, { silent: true });
      const mapped = (list || []).map((a) => ({
        id: a.id,
        title: a.title || '',
        preview: (a.content || '').slice(0, 60),
        pinned: a.pinned,
        date: (a.publishedAt || '').slice(0, 10),
      }));
      this.setData({ list: mapped, loading: false, error: false });
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

  async onPullDownRefresh() {
    try {
      await this.load();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/announcement-detail/announcement-detail?id=${e.currentTarget.dataset.id}` });
  },
});
