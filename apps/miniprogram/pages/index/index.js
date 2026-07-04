const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');

const THEMES = ['sapphire', 'emerald', 'amber'];

Page({
  data: {
    nav: { spacerPx: 48, rowPx: 32 },
    ready: false,
    noHouse: false,
    currentHouse: null,
    houses: [],
    unpaidTotal: '0.00',
    unpaidCount: 0,
    bills: [],
    quickActions: [
      { title: '报事报修', desc: '拍照一键上报', icon: '修', active: true },
      { title: '访客邀请', desc: '生成通行码', icon: '客' },
      { title: '社区公告', desc: '物业最新通知', icon: '告' },
    ],
    latestAnn: null, // 最新公告条
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
        this.setData({ ready: true, noHouse: true, bills: [], unpaidTotal: '0.00', unpaidCount: 0 });
        return;
      }
      this.setData({ noHouse: false, houses, currentHouse: app.globalData.currentHouse });
      await this.loadBills();
    } catch (e) {
      console.error(e);
    } finally {
      this.setData({ ready: true });
    }
  },

  async loadBills() {
    const house = getApp().globalData.currentHouse;
    if (!house) return;
    const [summary, billPage, anns] = await Promise.all([
      request(`/owner/bills/summary?houseId=${house.houseId}`),
      // pageSize 需覆盖全部未缴账单（goPay 用它合并下单）
      request(`/owner/bills?houseId=${house.houseId}&status=UNPAID&pageSize=50`),
      request(`/owner/announcements?houseId=${house.houseId}`).catch(() => []),
    ]);
    const bills = billPage.list.map((b, i) => ({
      id: b.id,
      title: b.title,
      desc: `${b.period} · 到期 ${(b.dueDate || '').slice(0, 10)}`,
      amount: Number(b.amount).toFixed(2),
      icon: b.title.slice(0, 1),
      theme: THEMES[i % THEMES.length],
    }));
    this.setData({
      currentHouse: house,
      unpaidTotal: summary.unpaidTotal,
      unpaidCount: summary.unpaidCount,
      bills,
      latestAnn: anns.length > 0 ? { id: anns[0].id, title: anns[0].title } : null,
    });
  },

  async onPullDownRefresh() {
    try {
      await this.loadBills();
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
        getApp().globalData.currentHouse = houses[res.tapIndex];
        await this.loadBills();
      },
    });
  },

  handleQuickTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (index === 0) wx.navigateTo({ url: '/pages/ticket-create/ticket-create' });
    if (index === 1) wx.navigateTo({ url: '/pages/visitor/visitor' });
    if (index === 2) wx.navigateTo({ url: '/pages/announcements/announcements' });
  },

  goAnn() {
    wx.navigateTo({
      url: this.data.latestAnn
        ? `/pages/announcement-detail/announcement-detail?id=${this.data.latestAnn.id}`
        : '/pages/announcements/announcements',
    });
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind-house/bind-house' });
  },

  goBill() {
    wx.switchTab({ url: '/pages/bill/bill' });
  },

  goBillDetail(e) {
    wx.navigateTo({ url: `/pages/bill-detail/bill-detail?id=${e.currentTarget.dataset.id}` });
  },

  /** 立即缴纳：当前房屋全部未缴账单 */
  goPay() {
    if (this.data.unpaidCount === 0) {
      wx.showToast({ title: '当前没有待缴账单', icon: 'none' });
      return;
    }
    getApp().globalData.pendingBills = this.data.bills.map((b) => ({ id: b.id, name: b.title, amount: b.amount }));
    wx.navigateTo({ url: '/pages/pay-confirm/pay-confirm' });
  },
});
