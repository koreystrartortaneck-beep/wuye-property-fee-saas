const { ensureAdmin, adminRequest, currentAdmin } = require('../../../utils/admin');

/*
 * 管理端首页 —— 给不用电脑的物业人员。
 *
 * 设计只有两件事:一个大搜索框(输房号直达那套房),几张待办卡(点进去干活)。
 * 没有仪表盘、没有图表:他要的是「今天该干什么、这户欠多少」,不是数据大屏。
 */

const DEBOUNCE_MS = 300;

Page({
  _timer: null,
  _ticket: 0,

  data: {
    adminName: '',
    denied: false,
    loading: true,
    /** 待办卡(取自 /admin/today,只留手机端能处理的几类) */
    todos: [],
    collection: null,
    arrears: null,
    keyword: '',
    houses: [],
    houseTotal: 0,
    searching: false,
  },

  async onShow() {
    try {
      const s = await ensureAdmin();
      this.setData({ adminName: s.name, denied: false });
      await this.loadToday();
    } catch (e) {
      /*
       * 非管理员点进来(转发链接/收藏)只会看到这句话 ——
       * 界面藏得再好也挡不住入口被转发,真正的门在服务端(AdminGuard)。
       */
      this.setData({ denied: true, loading: false });
    }
  },

  async loadToday() {
    this.setData({ loading: true });
    try {
      const d = await adminRequest('/admin/today', { silent: true });
      // 手机端 M1 只做得了绑定审批;其余待办先显示数字,提示去电脑端(M2/M3 逐步接)
      const ACTIONABLE = { bindings: '/packageAdmin/pages/approvals/approvals' };
      this.setData({
        todos: (d.todos || [])
          .filter((t) => t.count > 0)
          .map((t) => ({ ...t, url: ACTIONABLE[t.key] || '' })),
        collection: d.collection,
        arrears: d.arrears,
      });
    } catch (e) {
      // today 挂了不挡搜索:搜索才是高频主路径
    } finally {
      this.setData({ loading: false });
    }
  },

  onTodoTap(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.navigateTo({ url });
    else wx.showToast({ title: '这类事项请在电脑后台处理（手机端逐步支持）', icon: 'none' });
  },

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

  goHouse(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/packageAdmin/pages/house/house?id=${id}` });
  },

  onUnload() {
    clearTimeout(this._timer);
  },

  noop() {},
});
