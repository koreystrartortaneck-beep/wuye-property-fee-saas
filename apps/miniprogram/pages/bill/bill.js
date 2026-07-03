const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');

const THEMES = ['sapphire', 'emerald', 'amber'];
const STATUS_BY_TAB = [undefined, 'UNPAID', 'PAID']; // 全部 / 待缴 / 已缴
const STATUS_LABEL = { UNPAID: '待缴', PAID: '已缴', CANCELED: '已作废' };

Page({
  data: {
    tabs: ['全部', '待缴', '已缴'],
    activeTab: 1,
    house: null,
    bills: [],
    page: 1,
    total: 0,
    loadingMore: false,
    selectedIds: [],
    selectedTotal: '0.00',
    unpaidCount: 0,
    unpaidTotal: '0.00',
  },

  async onShow() {
    const app = getApp();
    await app.loginReady;
    const houses = await loadMyHouses().catch(() => []);
    if (houses.length === 0) {
      this.setData({ house: null, bills: [] });
      return;
    }
    this.setData({ house: app.globalData.currentHouse });
    await this.reload();
  },

  async reload() {
    this.setData({ page: 1, bills: [], selectedIds: [], selectedTotal: '0.00' });
    await this.fetchPage(1);
  },

  async fetchPage(page) {
    const { house, activeTab } = this.data;
    if (!house) return;
    const status = STATUS_BY_TAB[activeTab];
    const qs = `houseId=${house.houseId}&page=${page}&pageSize=20${status ? `&status=${status}` : ''}`;
    const res = await request(`/owner/bills?${qs}`);
    const now = new Date();
    const mapped = res.list.map((b, i) => {
      const overdue = b.status === 'UNPAID' && new Date(b.dueDate) < now;
      let subline = b.period;
      if (b.status === 'PAID' && b.paidAt) subline += ` · 缴于 ${b.paidAt.slice(0, 10)}`;
      else if (b.status === 'UNPAID') subline += ` · 到期 ${(b.dueDate || '').slice(0, 10)}`;
      return {
        id: b.id,
        title: b.title,
        subline,
        amount: Number(b.amount).toFixed(2),
        status: overdue ? '已逾期' : STATUS_LABEL[b.status] || b.status,
        overdue,
        paid: b.status !== 'UNPAID',
        theme: THEMES[i % THEMES.length],
      };
    });
    const bills = page === 1 ? mapped : this.data.bills.concat(mapped);
    // 已加载列表中未缴部分的合计（汇总卡默认展示）
    const unpaid = bills.filter((b) => !b.paid);
    const unpaidCents = unpaid.reduce((s, b) => s + Math.round(Number(b.amount) * 100), 0);
    this.setData({
      bills,
      total: res.total,
      page,
      unpaidCount: unpaid.length,
      unpaidTotal: (unpaidCents / 100).toFixed(2),
    });
  },

  async onReachBottom() {
    if (this.data.bills.length >= this.data.total || this.data.loadingMore) return;
    this.setData({ loadingMore: true });
    await this.fetchPage(this.data.page + 1);
    this.setData({ loadingMore: false });
  },

  async setTab(e) {
    this.setData({ activeTab: Number(e.currentTarget.dataset.index) });
    await this.reload();
  },

  async onPullDownRefresh() {
    await this.reload();
    wx.stopPullDownRefresh();
  },

  /** 整卡点击 → 账单详情（计费依据） */
  goDetailByIndex(e) {
    const bill = this.data.bills[Number(e.currentTarget.dataset.index)];
    if (!bill) return;
    wx.navigateTo({ url: `/pages/bill-detail/bill-detail?id=${bill.id}` });
  },

  /** 左侧勾选圈：选择/取消未缴账单（catchtap，不冒泡到详情） */
  toggleSelect(e) {
    const bill = this.data.bills[Number(e.currentTarget.dataset.index)];
    if (!bill || bill.paid) return;
    const ids = [...this.data.selectedIds];
    const pos = ids.indexOf(bill.id);
    if (pos >= 0) ids.splice(pos, 1);
    else ids.push(bill.id);
    const totalCents = this.data.bills
      .filter((b) => ids.includes(b.id))
      .reduce((s, b) => s + Math.round(Number(b.amount) * 100), 0);
    this.setData({ selectedIds: ids, selectedTotal: (totalCents / 100).toFixed(2) });
  },

  /** 合并缴纳：勾选的账单，没勾则默认全部未缴 */
  goPay() {
    const unpaid = this.data.bills.filter((b) => !b.paid);
    const chosen = this.data.selectedIds.length
      ? unpaid.filter((b) => this.data.selectedIds.includes(b.id))
      : unpaid;
    if (chosen.length === 0) {
      wx.showToast({ title: '没有可缴纳的账单', icon: 'none' });
      return;
    }
    getApp().globalData.pendingBills = chosen.map((b) => ({ id: b.id, name: b.title, amount: b.amount }));
    wx.navigateTo({ url: '/pages/pay-confirm/pay-confirm' });
  },
});
