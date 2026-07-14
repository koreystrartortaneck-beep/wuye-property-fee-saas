const { request } = require('../../utils/request');
const { imageUrl } = require('../../utils/upload');
const { loadMyHouses } = require('../../utils/auth');

const WORK_CAT = { INSPECTION: '巡检', CLEANING: '保洁', GREENING: '绿化', SECURITY: '安保', REPAIR: '维修', OTHER: '公示' };

function buildFeed(anns, works) {
  const annItems = (anns || []).map((a) => ({
    type: 'ann', id: a.id, title: a.title,
    preview: (a.content || '').replace(/\n+/g, ' ').slice(0, 60),
    pinned: a.pinned, date: (a.publishedAt || '').slice(0, 10),
    ts: Date.parse(a.publishedAt) || 0,
  }));
  const workItems = (works || [])
    .filter((w) => (w.images || []).length > 0)
    .map((w) => ({
      type: 'work', id: w.id, title: w.title || WORK_CAT[w.category] || '物业公示',
      preview: w.description || '', tag: WORK_CAT[w.category] || '公示',
      cover: imageUrl(w.images[0]), count: (w.images || []).length,
      date: (w.createdAt || '').slice(0, 10), ts: Date.parse(w.createdAt) || 0,
    }));
  const pinned = annItems.filter((a) => a.pinned).sort((x, y) => y.ts - x.ts);
  const rest = annItems.filter((a) => !a.pinned).concat(workItems).sort((x, y) => y.ts - x.ts);
  return pinned.concat(rest);
}

Page({
  data: {
    filters: [
      { value: 'all', label: '全部' },
      { value: 'ann', label: '公告' },
      { value: 'work', label: '物业公示' },
    ],
    active: 'all',
    all: [],
    feed: [],
    loading: true,
    error: false,
  },

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
        this.setData({ all: [], feed: [], loading: false, error: false });
        return;
      }
      const [anns, works] = await Promise.all([
        request(`/owner/announcements?houseId=${house.houseId}`, { silent: true }),
        request(`/owner/work-logs?houseId=${house.houseId}&pageSize=50`, { silent: true }),
      ]);
      const all = buildFeed(anns, (works || {}).list);
      this.setData({ all, loading: false, error: false });
      this.applyFilter();
    } catch (e) {
      if (this.data.feed.length === 0) {
        this.setData({ error: true, loading: false });
      } else {
        this.setData({ loading: false, error: false });
      }
    }
  },

  retry() {
    this.load();
  },

  applyFilter() {
    const { all, active } = this.data;
    this.setData({ feed: active === 'all' ? all : all.filter((f) => f.type === active) });
  },

  setFilter(e) {
    this.setData({ active: e.currentTarget.dataset.value });
    this.applyFilter();
  },

  async onPullDownRefresh() {
    try {
      await this.load();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  goItem(e) {
    const { id, type } = e.currentTarget.dataset;
    if (type === 'work') wx.navigateTo({ url: `/pages/work-detail/work-detail?id=${id}` });
    else wx.navigateTo({ url: `/pages/announcement-detail/announcement-detail?id=${id}` });
  },
});
