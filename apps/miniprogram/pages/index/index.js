const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');

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
    quickActions: [
      { title: '报事报修', desc: '拍照一键上报', icon: '修', active: true },
      { title: '访客邀请', desc: '生成通行码', icon: '客' },
      { title: '缴费记录', desc: '收据随时可查', icon: '票' },
    ],
    annList: [], // 社区动态（最多 3 条完整卡片）
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
        this.setData({ ready: true, noHouse: true, unpaidTotal: '0.00', unpaidCount: 0, annList: [] });
        return;
      }
      const nextHouse = app.globalData.currentHouse;
      // 房屋变了：先清掉上一个房屋的内容，杜绝"新房屋标题 + 旧房屋数据"同框
      const houseChanged = !this.data.currentHouse || this.data.currentHouse.houseId !== nextHouse.houseId;
      this.setData({
        noHouse: false,
        houses,
        currentHouse: nextHouse,
        ...(houseChanged ? { annList: [], unpaidTotal: '0.00', unpaidCount: 0, paidUp: false } : {}),
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
    const [summary, billPage, anns] = await Promise.all([
      request(`/owner/bills/summary?houseId=${house.houseId}`),
      // 未缴账单不再在首页展示，只为「立即缴纳」合并下单做准备
      request(`/owner/bills?houseId=${house.houseId}&status=UNPAID&pageSize=50`),
      request(`/owner/announcements?houseId=${house.houseId}`).catch(() => []),
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
      annList: anns.slice(0, 3).map((a) => ({
        id: a.id,
        title: a.title,
        preview: (a.content || '').replace(/\n+/g, ' ').slice(0, 56),
        pinned: a.pinned,
        date: (a.publishedAt || '').slice(5, 10).replace('-', '/'),
      })),
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

  handleQuickTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (index === 0) wx.navigateTo({ url: '/pages/ticket-create/ticket-create' });
    if (index === 1) wx.navigateTo({ url: '/pages/visitor/visitor' });
    if (index === 2) wx.navigateTo({ url: '/pages/payments/payments' });
  },

  goAnnList() {
    wx.navigateTo({ url: '/pages/announcements/announcements' });
  },

  goAnnDetail(e) {
    wx.navigateTo({ url: `/pages/announcement-detail/announcement-detail?id=${e.currentTarget.dataset.id}` });
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
