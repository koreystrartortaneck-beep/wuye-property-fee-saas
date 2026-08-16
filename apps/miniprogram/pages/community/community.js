const share = require('../../utils/share');
const { request } = require('../../utils/request');
const { imageUrl } = require('../../utils/upload');
const { loadMyHouses } = require('../../utils/auth');
const { fmtDate } = require('../../utils/datetime');
const { WORK_CATEGORY } = require('../../utils/labels');

// 分类文案的单一真源在 utils/labels.js。原先 4 个页面各写一份且互相矛盾：
// OTHER 一半是「公示」一半是「其他」，INSPECTION 一半是「巡检」一半是「日常巡检」，
// 业主在列表看到「巡检」点进详情会变成「日常巡检」。
const WORK_CAT = WORK_CATEGORY;

function buildFeed(anns, works) {
  const annItems = (anns || []).map((a) => ({
    type: 'ann', id: a.id, title: a.title,
    preview: (a.content || '').replace(/\n+/g, ' ').slice(0, 60),
    pinned: a.pinned, date: fmtDate(a.publishedAt),
    ts: Date.parse(a.publishedAt) || 0,
  }));
  const workItems = (works || [])
    .filter((w) => (w.images || []).length > 0)
    .map((w) => ({
      type: 'work', id: w.id, title: w.title || WORK_CAT[w.category] || '物业公示',
      preview: w.description || '', tag: WORK_CAT[w.category] || '公示',
      cover: imageUrl(w.images[0]), count: (w.images || []).length,
      date: fmtDate(w.createdAt), ts: Date.parse(w.createdAt) || 0,
    }));
  const pinned = annItems.filter((a) => a.pinned).sort((x, y) => y.ts - x.ts);
  const rest = annItems.filter((a) => !a.pinned).concat(workItems).sort((x, y) => y.ts - x.ts);
  return pinned.concat(rest);
}

Page({
  // 转发/朋友圈:没有这两个回调,菜单里的分享是灰的(2026-08-15 实测)
  onShareAppMessage: share.onShareAppMessage,
  onShareTimeline: share.onShareTimeline,

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
