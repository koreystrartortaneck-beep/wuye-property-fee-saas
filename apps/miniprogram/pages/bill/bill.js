const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');

const THEMES = ['sapphire', 'emerald', 'amber'];
const STATUS_BY_TAB = [undefined, 'UNPAID', 'PAID']; // 全部 / 待缴 / 已缴
const STATUS_LABEL = { UNPAID: '待缴', PAID: '已缴', CANCELED: '已作废' };

Page({
  data: {
    nav: { spacerPx: 48, rowPx: 32 },
    tabs: ['全部', '待缴', '已缴'],
    activeTab: 1,
    house: null,
    // 科目筛选条：首项恒为「全部」
    filters: [{ ruleId: '', name: '全部' }],
    activeRuleId: '',
    bills: [], // 平铺（选择计算用）
    groups: [], // 按账期分组（渲染用）[{period, subtotal, count, items}]
    page: 1,
    total: 0,
    loadingMore: false,
    selectedIds: [],
    selMap: {}, // WXML 不支持 indexOf()，用查表渲染选中态
    selectedTotal: '0.00',
    unpaidCount: 0,
    unpaidTotal: '0.00',
  },

  onLoad() {
    this.setData({ nav: getApp().globalData.nav });
  },

  async onShow() {
    const app = getApp();
    await app.loginReady;
    const houses = await loadMyHouses().catch(() => []);
    if (houses.length === 0) {
      this.setData({ house: null, bills: [], groups: [] });
      return;
    }
    const house = app.globalData.currentHouse;
    const houseChanged = !this.data.house || this.data.house.houseId !== house.houseId;
    this.setData({ house });
    if (houseChanged) await this.loadFilters();
    await this.reload();
  },

  /** 该房屋实际存在的费用科目 */
  async loadFilters() {
    const list = await request(`/owner/bills/filters?houseId=${this.data.house.houseId}`).catch(() => []);
    this.setData({
      filters: [{ ruleId: '', name: '全部' }, ...list],
      activeRuleId: '',
    });
  },

  async reload() {
    this.setData({ page: 1, bills: [], groups: [], selectedIds: [], selMap: {}, selectedTotal: '0.00' });
    await this.fetchPage(1);
  },

  async fetchPage(page) {
    const { house, activeTab, activeRuleId } = this.data;
    if (!house) return;
    const status = STATUS_BY_TAB[activeTab];
    const qs =
      `houseId=${house.houseId}&page=${page}&pageSize=20` +
      (status ? `&status=${status}` : '') +
      (activeRuleId ? `&ruleId=${activeRuleId}` : '');
    const res = await request(`/owner/bills?${qs}`);
    const now = new Date();
    const mapped = res.list.map((b, i) => {
      const overdue = b.status === 'UNPAID' && new Date(b.dueDate) < now;
      let subline = '';
      if (b.status === 'PAID' && b.paidAt) subline = `缴于 ${b.paidAt.slice(0, 10)}`;
      else if (b.status === 'UNPAID') subline = `到期 ${(b.dueDate || '').slice(0, 10)}`;
      else subline = '已作废';
      return {
        id: b.id,
        periodKey: b.period,
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
    const unpaid = bills.filter((b) => !b.paid);
    const unpaidCents = unpaid.reduce((s, b) => s + Math.round(Number(b.amount) * 100), 0);
    this.setData({
      bills,
      groups: this.buildGroups(bills),
      total: res.total,
      page,
      unpaidCount: unpaid.length,
      unpaidTotal: (unpaidCents / 100).toFixed(2),
    });
  },

  /** 按账期分组（保持服务端排序，组内小计） */
  buildGroups(bills) {
    const order = [];
    const map = {};
    for (const b of bills) {
      if (!map[b.periodKey]) {
        map[b.periodKey] = { period: b.periodKey, items: [], cents: 0 };
        order.push(b.periodKey);
      }
      map[b.periodKey].items.push(b);
      map[b.periodKey].cents += Math.round(Number(b.amount) * 100);
    }
    // 账期倒序（新的在上）
    order.sort((a, b) => (a < b ? 1 : -1));
    return order.map((k) => ({
      period: map[k].period,
      count: map[k].items.length,
      subtotal: (map[k].cents / 100).toFixed(2),
      items: map[k].items,
    }));
  },

  async onReachBottom() {
    if (this.data.bills.length >= this.data.total || this.data.loadingMore) return;
    this.setData({ loadingMore: true });
    await this.fetchPage(this.data.page + 1);
    this.setData({ loadingMore: false });
  },

  async onPullDownRefresh() {
    try {
      await this.reload();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  async setTab(e) {
    this.setData({ activeTab: Number(e.currentTarget.dataset.index) });
    await this.reload();
  },

  async setFilter(e) {
    this.setData({ activeRuleId: e.currentTarget.dataset.id });
    await this.reload();
  },

  /** 整卡点击 → 账单详情 */
  goDetailById(e) {
    wx.navigateTo({ url: `/pages/bill-detail/bill-detail?id=${e.currentTarget.dataset.id}` });
  },

  /** 左侧勾选圈（catchtap） */
  toggleSelect(e) {
    const id = e.currentTarget.dataset.id;
    const bill = this.data.bills.find((b) => b.id === id);
    if (!bill || bill.paid) return;
    const ids = [...this.data.selectedIds];
    const pos = ids.indexOf(id);
    if (pos >= 0) ids.splice(pos, 1);
    else ids.push(id);
    const selMap = {};
    for (const i of ids) selMap[i] = true;
    const totalCents = this.data.bills
      .filter((b) => ids.includes(b.id))
      .reduce((s, b) => s + Math.round(Number(b.amount) * 100), 0);
    this.setData({ selectedIds: ids, selMap, selectedTotal: (totalCents / 100).toFixed(2) });
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
