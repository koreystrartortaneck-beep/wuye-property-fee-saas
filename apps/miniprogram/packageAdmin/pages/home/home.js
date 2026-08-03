const { ensureAdmin, adminRequest } = require('../../../utils/admin');

/*
 * 管理端首页 = 楼盘图。
 *
 * 实测反馈:搜索框适合接电话查户,但物业日常巡查的心智是**空间的** ——
 * 哪栋、哪单元、哪层、哪户,颜色即状态。这是收费软件的经典视图:
 * 点亮楼栋 → 楼层格子铺开,欠费标红(带金额),点格子直达那套房。
 *
 * 551 套的完整网格一次拉回(约 40KB),按选中的楼栋增量 setData ——
 * 一次性渲染全部会卡,渲染单栋(≤200 格)很流畅。
 */

const DEBOUNCE_MS = 300;

/*
 * 列数由「这个单元最宽的一层有几户」定,上限 4。
 *
 * 原来格子是 flex:1 撑满整行:住宅一层两户时很好看,但门市一层 11 户就被压成
 * 60rpx 宽 —— 实测截图里 001~011 挤成了「001002003…」,一个房号都读不出来。
 * 定列数还带来一个真正的好处:每层同一列 = 同一个位置,和纸质楼盘表对得上。
 */
function withColumns(unit) {
  const widest = (unit.floors || []).reduce((m, f) => Math.max(m, (f.cells || []).length), 0);
  return { ...unit, cols: Math.min(4, Math.max(2, widest)) };
}

Page({
  _timer: null,
  _ticket: 0,
  _grid: null, // 完整网格缓存(内存,页面级)

  data: {
    adminName: '',
    denied: false,
    loading: true,
    todos: [],
    gridError: '',
    /** 楼栋条:[{building, houses, unpaidHouses}] */
    buildings: [],
    picked: '',
    /** 选中楼栋的单元列表(渲染用) */
    units: [],
    keyword: '',
    houses: [],
    houseTotal: 0,
    searching: false,
    communityId: '',
    /** 欠费概览(有欠费才显示) */
    arrears: null,
  },

  async onShow() {
    let s;
    try {
      s = await ensureAdmin();
    } catch (e) {
      /*
       * 只有身份换发失败才是「没有管理权限」。
       * 数据加载失败(网络/接口)是另一码事,必须分开渲染 ——
       * 把一切失败都塞进权限错误页,等于对着有权限的人说「你没权限」。
       */
      this.setData({ denied: true, loading: false });
      return;
    }
    this.setData({ adminName: s.name, denied: false, gridError: '' });
    await Promise.all([this.loadTodos(), this.loadGrid()]);
  },

  async loadTodos() {
    try {
      const d = await adminRequest('/admin/today', { silent: true });
      const ACTIONABLE = {
        bindings: '/packageAdmin/pages/approvals/approvals',
        // 「本月账单已生成待发布」以前点了只弹「请在电脑后台处理」——
        // 手机端现在能发布,这条必须能点进去,否则待办等于在通知你回办公室
        draftBatch: '/packageAdmin/pages/batches/batches',
        tickets: '/packageAdmin/pages/tickets/tickets',
      };
      this.setData({
        todos: (d.todos || [])
          .filter((t) => t.count > 0)
          .map((t) => ({ ...t, url: ACTIONABLE[t.key] || '' })),
        // 欠费不在 todos 里(它不是「待处理单据」而是常态),单独给一条入口
        arrears:
          d.arrears && d.arrears.houses > 0
            ? { houses: d.arrears.houses, amount: d.arrears.amount, overdueHouses: d.arrears.overdueHouses }
            : null,
      });
    } catch (e) {
      // 待办挂了不挡楼盘图
    }
  },

  async loadGrid() {
    this.setData({ loading: true });
    try {
      /*
       * 小区列表必须走 /admin/communities —— 管理员令牌配管理端的门。
       * 2026-08-03 实测:这里原来调的是业主端的 /owner/communities,
       * 管理员令牌被 OwnerGuard 拒掉 → 异常抛到外层 → 被渲染成
       * 「没有管理权限」。用户明明有权限(审计里躺着成功换发),
       * 界面却说他没有 —— 错误页说谎比报错本身严重。
       */
      const cs = await adminRequest('/admin/communities?page=1&pageSize=100', { silent: true });
      const community = (cs.list || []).find((c) => c.status === 'ACTIVE');
      if (!community) {
        this.setData({ gridError: '还没有在营小区' });
        return;
      }
      const grid = await adminRequest(`/admin/houses-grid?communityId=${community.id}`, { silent: true });
      this._grid = grid.buildings || [];
      const buildings = this._grid.map((b) => ({ building: b.building, houses: b.houses, unpaidHouses: b.unpaidHouses }));
      this.setData({ communityId: community.id, buildings });
      // 默认展开第一栋:进来就有东西看,而不是一排按钮等人猜
      if (this._grid.length > 0 && !this.data.picked) this.pickBuildingByName(this._grid[0].building);
    } catch (e) {
      this.setData({ gridError: '楼盘图加载失败,请检查网络后点此重试' });
    } finally {
      this.setData({ loading: false });
    }
  },

  retryGrid() {
    this.setData({ gridError: '' });
    void this.loadGrid();
  },

  pickBuilding(e) {
    this.pickBuildingByName(e.currentTarget.dataset.b);
  },

  pickBuildingByName(name) {
    const b = (this._grid || []).find((x) => x.building === name);
    if (!b) return;
    this.setData({ picked: name, units: b.units.map(withColumns) });
  },

  goHouse(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/packageAdmin/pages/house/house?id=${id}` });
  },

  goBilling() {
    wx.navigateTo({ url: `/packageAdmin/pages/billing/billing?communityId=${this.data.communityId}` });
  },

  goAnnounce() {
    wx.navigateTo({ url: `/packageAdmin/pages/announce/announce?communityId=${this.data.communityId}` });
  },

  goDun() {
    wx.navigateTo({ url: '/packageAdmin/pages/dun/dun' });
  },

  goTickets() {
    wx.navigateTo({ url: '/packageAdmin/pages/tickets/tickets' });
  },

  onTodoTap(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.navigateTo({ url });
    else wx.showToast({ title: '这类事项请在电脑后台处理', icon: 'none' });
  },

  /* ── 搜索(保留:接电话查户仍是它快) ── */
  onKeywordInput(e) {
    const keyword = e.detail.value;
    this.setData({ keyword });
    clearTimeout(this._timer);
    if (!keyword.trim()) {
      this.setData({ houses: [], houseTotal: 0, searching: false });
      return;
    }
    this._timer = setTimeout(() => this.search(), DEBOUNCE_MS);
  },

  async search() {
    const keyword = this.data.keyword.trim();
    if (!keyword) return;
    const ticket = ++this._ticket;
    this.setData({ searching: true });
    try {
      const d = await adminRequest(`/admin/houses?keyword=${encodeURIComponent(keyword)}&page=1&pageSize=20`, { silent: true });
      if (ticket !== this._ticket) return;
      this.setData({ houses: d.list || [], houseTotal: d.total || 0 });
    } catch (e) {
      if (ticket === this._ticket) this.setData({ houses: [], houseTotal: 0 });
    } finally {
      if (ticket === this._ticket) this.setData({ searching: false });
    }
  },

  onUnload() {
    clearTimeout(this._timer);
  },
});
