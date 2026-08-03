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

Page({
  _timer: null,
  _ticket: 0,
  _grid: null, // 完整网格缓存(内存,页面级)

  data: {
    adminName: '',
    denied: false,
    loading: true,
    todos: [],
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
  },

  async onShow() {
    try {
      const s = await ensureAdmin();
      this.setData({ adminName: s.name, denied: false });
      await Promise.all([this.loadTodos(), this.loadGrid()]);
    } catch (e) {
      this.setData({ denied: true, loading: false });
    }
  },

  async loadTodos() {
    try {
      const d = await adminRequest('/admin/today', { silent: true });
      const ACTIONABLE = { bindings: '/packageAdmin/pages/approvals/approvals' };
      this.setData({
        todos: (d.todos || [])
          .filter((t) => t.count > 0)
          .map((t) => ({ ...t, url: ACTIONABLE[t.key] || '' })),
      });
    } catch (e) {
      // 待办挂了不挡楼盘图
    }
  },

  async loadGrid() {
    this.setData({ loading: true });
    try {
      // 单租户单在营小区;将来多小区在这里加切换条
      const cs = await adminRequest('/owner/communities', { silent: true });
      const community = (cs.items || [])[0];
      if (!community) return;
      const grid = await adminRequest(`/admin/houses-grid?communityId=${community.id}`, { silent: true });
      this._grid = grid.buildings || [];
      const buildings = this._grid.map((b) => ({ building: b.building, houses: b.houses, unpaidHouses: b.unpaidHouses }));
      this.setData({ communityId: community.id, buildings });
      // 默认展开第一栋:进来就有东西看,而不是一排按钮等人猜
      if (this._grid.length > 0 && !this.data.picked) this.pickBuildingByName(this._grid[0].building);
    } finally {
      this.setData({ loading: false });
    }
  },

  pickBuilding(e) {
    this.pickBuildingByName(e.currentTarget.dataset.b);
  },

  pickBuildingByName(name) {
    const b = (this._grid || []).find((x) => x.building === name);
    if (!b) return;
    this.setData({ picked: name, units: b.units });
  },

  goHouse(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/packageAdmin/pages/house/house?id=${id}` });
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
