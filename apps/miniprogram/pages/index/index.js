const { request } = require('../../utils/request');
const { imageUrl } = require('../../utils/upload');
const { loadMyHouses } = require('../../utils/auth');

const WORK_CAT = { INSPECTION: '巡检', CLEANING: '保洁', GREENING: '绿化', SECURITY: '安保', REPAIR: '维修', OTHER: '公示' };

/** 公告 + 物业公示 混排成一条社区动态流（公告置顶优先，其余按时间倒序） */
function buildFeed(anns, works) {
  const annItems = (anns || []).map((a) => ({
    type: 'ann',
    id: a.id,
    title: a.title,
    preview: (a.content || '').replace(/\n+/g, ' ').slice(0, 56),
    pinned: a.pinned,
    date: (a.publishedAt || '').slice(5, 10).replace('-', '/'),
    ts: Date.parse(a.publishedAt) || 0,
  }));
  const workItems = (works || [])
    .filter((w) => (w.images || []).length > 0)
    .map((w) => ({
      type: 'work',
      id: w.id,
      title: w.title || WORK_CAT[w.category] || '物业公示',
      preview: w.description || '',
      tag: WORK_CAT[w.category] || '公示',
      cover: imageUrl(w.images[0]),
      count: (w.images || []).length,
      date: (w.createdAt || '').slice(5, 10).replace('-', '/'),
      ts: Date.parse(w.createdAt) || 0,
    }));
  const pinned = annItems.filter((a) => a.pinned).sort((x, y) => y.ts - x.ts);
  const rest = annItems.filter((a) => !a.pinned).concat(workItems).sort((x, y) => y.ts - x.ts);
  return pinned.concat(rest);
}

Page({
  data: {
    nav: { spacerPx: 48, rowPx: 32 },
    ready: false,
    noHouse: false,
    currentHouse: null,
    houses: [],
    unpaidTotal: '0.00',
    unpaidCount: 0,
    paidUp: false, // 本期已缴清
    feed: [], // 社区动态：公告 + 物业公示混排
  },

  onLoad() {
    this.setData({ nav: getApp().globalData.nav });
  },

  async onShow() {
    const app = getApp();
    await app.loginReady;
    try {
      const houses = await loadMyHouses();
      if (houses.length === 0) {
        this.setData({ ready: true, noHouse: true, unpaidTotal: '0.00', unpaidCount: 0, feed: [] });
        return;
      }
      const nextHouse = app.globalData.currentHouse;
      // 房屋变了：先清掉上一个房屋的内容，杜绝"新房屋标题 + 旧房屋数据"同框
      const houseChanged = !this.data.currentHouse || this.data.currentHouse.houseId !== nextHouse.houseId;
      this.setData({
        noHouse: false,
        houses,
        currentHouse: nextHouse,
        ...(houseChanged ? { feed: [], unpaidTotal: '0.00', unpaidCount: 0, paidUp: false } : {}),
      });
      await this.loadHome();
    } catch (e) {
      console.error(e);
    } finally {
      this.setData({ ready: true });
    }
  },

  async loadHome() {
    const house = getApp().globalData.currentHouse;
    if (!house) return;
    const [summary, billPage, anns, works] = await Promise.all([
      request(`/owner/bills/summary?houseId=${house.houseId}`),
      // 未缴账单不再在首页展示，只为「立即缴纳」合并下单做准备
      request(`/owner/bills?houseId=${house.houseId}&status=UNPAID&pageSize=50`),
      request(`/owner/announcements?houseId=${house.houseId}`).catch(() => []),
      request(`/owner/work-logs?houseId=${house.houseId}&pageSize=8`).catch(() => ({ list: [] })),
    ]);
    this._unpaidBills = billPage.list.map((b) => ({
      id: b.id,
      name: b.title,
      amount: Number(b.amount).toFixed(2),
    }));
    this.setData({
      currentHouse: house,
      unpaidTotal: summary.unpaidTotal,
      unpaidCount: summary.unpaidCount,
      paidUp: summary.unpaidCount === 0,
      feed: buildFeed(anns, works.list).slice(0, 8),
    });
  },

  async onPullDownRefresh() {
    try {
      await this.loadHome();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  /** 多房切换 */
  switchHouse() {
    const { houses } = this.data;
    if (houses.length <= 1) return;
    wx.showActionSheet({
      itemList: houses.map((h) => `${h.communityName} ${h.displayName}`),
      success: async (res) => {
        const target = houses[res.tapIndex];
        getApp().globalData.currentHouse = target;
        // 先清旧数据再加载，避免切换瞬间的脏渲染
        this.setData({
          currentHouse: target,
          annList: [],
          unpaidTotal: '0.00',
          unpaidCount: 0,
          paidUp: false,
        });
        await this.loadHome();
      },
    });
  },

  /** 社区动态「查看全部」→ 统一动态流页 */
  goFeed() {
    wx.navigateTo({ url: '/pages/community/community' });
  },

  /** 点击一条动态：按类型进对应详情 */
  goFeedItem(e) {
    const { id, type } = e.currentTarget.dataset;
    if (type === 'work') wx.navigateTo({ url: `/pages/work-detail/work-detail?id=${id}` });
    else wx.navigateTo({ url: `/pages/announcement-detail/announcement-detail?id=${id}` });
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind-house/bind-house' });
  },

  goBill() {
    wx.switchTab({ url: '/pages/bill/bill' });
  },

  /** 英雄卡主按钮：有待缴→合并缴纳；已缴清→查看账单 */
  heroAction() {
    if (this.data.paidUp) {
      this.goBill();
      return;
    }
    getApp().globalData.pendingBills = this._unpaidBills || [];
    wx.navigateTo({ url: '/pages/pay-confirm/pay-confirm' });
  },
});
