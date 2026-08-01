const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');
const labels = require('../../utils/labels');
const { accrueSubscribeQuota } = require('../../utils/subscribe');
const { fmtDate } = require('../../utils/datetime');
const STATUS_LABEL = labels.BILL_STATUS;

const THEMES = ['sapphire', 'emerald', 'amber'];
const STATUS_BY_TAB = [undefined, 'UNPAID', 'PAID']; // 全部 / 待缴 / 已缴

Page({
  data: {
    error: false, // 加载失败：必须与「真的没有账单」区分开
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
    /*
     * 汇总是独立请求，必须有自己的加载/失败态。
     * 光有初值 0 的话，首屏与请求失败时都会显示「¥ 0.00」——
     * 业主据此以为自己没有欠费，而同屏的列表里列着十几笔。
     */
    summaryLoaded: false,
    summaryError: false,
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
    this.setData({ summaryError: false });
    try {
      const s = await request(`/owner/bills/summary?houseId=${this.data.house.houseId}`, { silent: true });
      this.setData({
        unpaidCount: s.unpaidCount || 0,
        unpaidTotal: s.unpaidTotal || '0.00',
        summaryLoaded: true,
      });
    } catch (e) {
      /*
       * 失败时不能装作有值。
       * 原来只写「保留旧值」——首次加载时旧值就是 0.00，等于把「取不到」显示成「没欠费」。
       * 已有值的情况下保留旧值是对的（刷新失败不该把已显示的数字抹掉），
       * 所以只在从未成功过时才切到错误态。
       */
      if (!this.data.summaryLoaded) this.setData({ summaryError: true });
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
    this.setData({ page: 1, bills: [], groups: [], error: false });
    try {
      await this.fetchPage(1, this._reqToken);
    } catch (e) {
      /*
       * 原先 fetchPage 抛出的异常一路冒到 onShow 之外，没人处理，于是 bills 保持
       * 空数组、界面显示「暂无账单 / 当前分类下没有账单」——业主会以为自己这个月
       * 没有账单，而实际上是网络失败。
       */
      console.error(e);
      this.setData({ error: true });
    }
  },

  retry() {
    this.reload();
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
    /*
     * 分组头部的「N 笔 · ¥X」必须来自权威接口。
     *
     * 列表按 status/createdAt 排序而**不按账期**，同一账期的账单散落在不同分页里，
     * 所以按已加载页算出来的小计是偏小的错数 —— 而它长得像个权威数字。
     * 业主想知道「5 月欠多少」，读到的就是错的。
     *
     * 只在第一页拉一次：翻页不改变筛选条件，小计不会变。
     */
    const [res, periodTotals] = await Promise.all([
      request(`/owner/bills?${qs}`),
      page === 1
        ? request(`/owner/bills/by-period?${qs}`, { silent: true }).catch(() => null)
        : Promise.resolve(this._periodTotals || null),
    ]);
    // 过期响应直接丢弃，避免覆盖当前筛选结果
    if (myToken !== this._reqToken) return;
    const now = new Date();
    const mapped = res.list.map((b, i) => {
      /*
       * settling：业主已经付过钱、微信也确认了，只是我们还没销账（通常几秒）。
       * 这一屏是业主付完款最可能回来看的地方 —— 2026-08-01 事故里他看到的是
       * 「待缴」，而钱明明已经扣了。既不能显示「待缴」（像是没付成功），
       * 也不能显示「已缴」（我们确实还没收到账），所以给它自己的状态。
       */
      const settling = b.status === 'UNPAID' && b.settling;
      const overdue = !settling && b.status === 'UNPAID' && new Date(b.dueDate) < now;
      let subline = '';
      if (b.status === 'PAID' && b.paidAt) subline = `缴于 ${fmtDate(b.paidAt)}`;
      else if (settling) subline = '微信已扣款，正在入账';
      else if (b.status === 'UNPAID') subline = `到期 ${fmtDate(b.dueDate)}`;
      else if (b.status === 'REFUNDED') subline = '已退款';
      else if (b.status === 'REFUNDING') subline = '退款处理中';
      else subline = '已作废';
      return {
        id: b.id,
        periodKey: b.period,
        title: b.title,
        subline,
        amount: Number(b.amount).toFixed(2),
        status: settling ? '入账中' : overdue ? '已逾期' : STATUS_LABEL[b.status] || b.status,
        overdue,
        settling,
        // 入账中的账单不能再点「缴费」——否则业主会为同一笔账单付第二次
        paid: b.status !== 'UNPAID' || settling,
        theme: THEMES[i % THEMES.length],
      };
    });
    this._periodTotals = periodTotals;
    const bills = page === 1 ? mapped : this.data.bills.concat(mapped);
    // 注意：待缴合计/笔数由 loadSummary() 从权威接口取，这里不再按当前页估算
    this.setData({
      bills,
      groups: this.buildGroups(bills),
      total: res.total,
      page,
    });
  },

  /**
   * 按账期分组。
   *
   * 组内小计取权威接口的数字，不按当前已加载页算 —— 列表不按账期排序，
   * 已加载页里的同账期账单往往只是一部分，按它求和会给出偏小的错数。
   *
   * 权威数字拿不到时（接口失败）不显示小计，只显示已加载的笔数并注明。
   * 宁可少一个数字，也不能显示一个看起来权威的错数 —— 这是钱。
   */
  buildGroups(bills) {
    const order = [];
    const map = {};
    for (const b of bills) {
      if (!map[b.periodKey]) {
        map[b.periodKey] = { period: b.periodKey, items: [] };
        order.push(b.periodKey);
      }
      map[b.periodKey].items.push(b);
    }
    // 账期倒序（新的在上）
    order.sort((a, b) => (a < b ? 1 : -1));
    const totals = {};
    for (const t of this._periodTotals || []) totals[t.period] = t;
    return order.map((k) => {
      const t = totals[k];
      return {
        period: map[k].period,
        // 有权威数字就用它；没有就退化成「已加载 N 笔」，不给小计
        count: t ? t.count : map[k].items.length,
        subtotal: t ? Number(t.amount).toFixed(2) : '',
        partial: !t,
        items: map[k].items,
      };
    });
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
