const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');

const THEMES = ['sapphire', 'emerald', 'amber'];

Page({
  data: {
    ready: false,
    noHouse: false,
    currentHouse: null,
    houses: [],
    unpaidTotal: '0.00',
    unpaidCount: 0,
    bills: [],
    quickActions: [
      { title: '账单明细', desc: '查看全部账单', icon: '账', active: true },
      { title: '缴费记录', desc: '历史付款凭证', icon: '票' },
      { title: '我的房屋', desc: '绑定与切换', icon: '房' },
    ],
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
    const [summary, billPage] = await Promise.all([
      request(`/owner/bills/summary?houseId=${house.houseId}`),
      // pageSize 需覆盖全部未缴账单（goPay 用它合并下单）
      request(`/owner/bills?houseId=${house.houseId}&status=UNPAID&pageSize=50`),
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
    if (index === 0) wx.switchTab({ url: '/pages/bill/bill' });
    if (index === 1) wx.navigateTo({ url: '/pages/payments/payments' });
    if (index === 2) wx.navigateTo({ url: '/pages/bind-house/bind-house' });
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind-house/bind-house' });
  },

  goBill() {
    wx.switchTab({ url: '/pages/bill/bill' });
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
