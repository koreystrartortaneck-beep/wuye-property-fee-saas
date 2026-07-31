const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');
const labels = require('../../utils/labels');
const { accrueSubscribeQuota } = require('../../utils/subscribe');
const STATUS_LABEL = labels.BILL_STATUS;

const THEMES = ['sapphire', 'emerald', 'amber'];
const STATUS_BY_TAB = [undefined, 'UNPAID', 'PAID']; // 全部 / 待缴 / 已缴

Page({
  data: {
    nav: { spacerPx: 48, rowPx: 32 },
    tabs: ['全部', '待缴', '已缴'],
    activeTab: 1,
    house: null,
    // 科目筛选条：首项恒为「全部」
    filters: [{ ruleId: '', name: '全部' }],
    activeRuleId: '',
    bills: [], // 平铺
    groups: [], // 按账期分组（渲染用）[{period, subtotal, count, items}]
    page: 1,
    total: 0,
    loadingMore: false,
    unpaidCount: 0,
    unpaidTotal: '0.00',
  },

  onLoad() {
    this.setData({ nav: getApp().globalData.nav });
  },

  async onShow() {
    const app = getApp();
    await app.loginReady;
    let houses = [];
    try {
      houses = await loadMyHouses();
    } catch (e) {
      houses = app.globalData.houses || [];
    }
    if (houses.length === 0) {
      this.setData({ house: null, noHouse: true, bills: [], groups: [], unpaidCount: 0, unpaidTotal: '0.00' });
      return;
    }
    const house = app.globalData.currentHouse;
    const houseChanged = !this.data.house || this.data.house.houseId !== house.houseId;
    this.setData({ house, noHouse: false });
    // 科目筛选条必须每次都刷新：物业新增收费科目后，同一套房也会出现新科目，
    // 只在换房时刷新会导致新科目永远不出现。
    await this.loadFilters();
    await this.reload();
    await this.loadSummary();
  },

  /** 待缴合计以权威 summary 为准（不受当前分页影响） */
  async loadSummary() {
    if (!this.data.house) return;
    try {
      const s = await request(`/owner/bills/summary?houseId=${this.data.house.houseId}`, { silent: true });
      this.setData({ unpaidCount: s.unpaidCount || 0, unpaidTotal: s.unpaidTotal || '0.00' });
    } catch (e) {
      /* 保留旧值 */
    }
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind-house/bind-house' });
  },

  /** 该房屋实际存在的费用科目 */
  async loadFilters() {
    const list = await request(`/owner/bills/filters?houseId=${this.data.house.houseId}`).catch(() => []);
    // 保留用户已选科目；仅当它在新列表里不存在（换房或科目消失）时才回到「全部」，
    // 否则每次进入页面都会把筛选清掉。
    const stillThere = (list || []).some((f) => f.ruleId === this.data.activeRuleId);
    this.setData({
      filters: [{ ruleId: '', name: '全部' }, ...(list || [])],
      activeRuleId: stillThere ? this.data.activeRuleId : '',
    });
  },

  /**
   * 每次重载递增令牌：快速切换 tab / 科目时，先发的请求可能后返回，
   * 从而覆盖列表或把上一筛选的第 2 页数据 concat 进新列表。
   */
  _reqToken: 0,

  async reload() {
    this._reqToken += 1;
    this.setData({ page: 1, bills: [], groups: [] });
    await this.fetchPage(1, this._reqToken);
  },

  async fetchPage(page, token) {
    const { house, activeTab, activeRuleId } = this.data;
    if (!house) return;
    const status = STATUS_BY_TAB[activeTab];
    const qs =
      `houseId=${house.houseId}&page=${page}&pageSize=20` +
      (status ? `&status=${status}` : '') +
      (activeRuleId ? `&ruleId=${activeRuleId}` : '');
    const myToken = token === undefined ? this._reqToken : token;
    const res = await request(`/owner/bills?${qs}`);
    // 过期响应直接丢弃，避免覆盖当前筛选结果
    if (myToken !== this._reqToken) return;
    const now = new Date();
    const mapped = res.list.map((b, i) => {
      const overdue = b.status === 'UNPAID' && new Date(b.dueDate) < now;
      let subline = '';
      if (b.status === 'PAID' && b.paidAt) subline = `缴于 ${b.paidAt.slice(0, 10)}`;
      else if (b.status === 'UNPAID') subline = `到期 ${(b.dueDate || '').slice(0, 10)}`;
      else if (b.status === 'REFUNDED') subline = '已退款';
      else if (b.status === 'REFUNDING') subline = '退款处理中';
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
    // 注意：待缴合计/笔数由 loadSummary() 从权威接口取，这里不再按当前页估算
    this.setData({
      bills,
      groups: this.buildGroups(bills),
      total: res.total,
      page,
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
    try {
      await this.fetchPage(this.data.page + 1, this._reqToken);
    } finally {
      this.setData({ loadingMore: false });
    }
  },

  async onPullDownRefresh() {
    try {
      await this.loadFilters();
      await this.reload();
      await this.loadSummary();
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
    /*
     * 顺带累积订阅额度。物业类目拿不到微信「长期订阅」，只能用一次性订阅——
     * 业主授权一次只能收一条。但授权弹窗有「总是保持以上选择，不再询问」，
     * 勾过之后后续调用自动通过且不弹窗，所以在业主本来就要点的地方多调一次，
     * 对勾过的人完全无感，额度却能持续累积。不 await，不影响跳转。
     */
    accrueSubscribeQuota();
    wx.navigateTo({ url: `/pages/bill-detail/bill-detail?id=${e.currentTarget.dataset.id}` });
  },

  /** 单账单缴费：跳确认页（由确认页向后端复核金额与收款状态后下单） */
  payBill(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/pay-confirm/pay-confirm?billId=${id}` });
  },
});
