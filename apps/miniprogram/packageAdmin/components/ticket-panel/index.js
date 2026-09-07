/*
 * 报事报修 —— 面板组件。
 *
 * 为什么是组件而不是页面:首页要在一屏之内横向切「楼盘图 / 欠费 / 报修 / 待发布」,
 * 而这几块各有几十行逻辑。做成组件,首页与独立页面共用同一份实现 ——
 * 把它抄一份进首页,就是「改一处漏一处」的开始。
 *
 * active 由外部给:变成 true 时才拉数据(没点开的标签不该占网络);
 * 首页每次 onShow 也会让当前面板重新拉一次(收完款回来,数字要变)。
 */
const { adminRequest, currentAdmin } = require('../../../utils/admin');
// 枚举文案一律取自 utils/labels(与后端枚举有守卫比对),页面不自建映射
const { TICKET_TYPE, TICKET_STATUS, label } = require('../../../utils/labels');
const { fetchAll, pageSlice } = require('../../list');
const { fmtDateTimeSec } = require('../../../utils/datetime');

Component({
  properties: {
    /** 外部控制:这一块正在被看着吗 —— 只有被看着才拉数据 */
    active: {
      type: Boolean,
      value: false,
      observer(on) {
        if (on) void this.load();
      },
    },
  },

  data: {
    loading: true,
    loadError: false,
    pending: [],
    visibleRows:[], selectedStatus:'PENDING', page:1,pages:1,
    processing: [],
    done: [],
    showDone: false,
    busy: '',
  },

  methods: {


  async load() {
    this.setData({ loading: this.data.pending.length + this.data.processing.length + this.data.done.length === 0, loadError: false });
    try {
      const d = { list: await fetchAll('/admin/tickets') };
      const rows = (d.list || []).map((t) => ({
        id: t.id,
        typeText: label(TICKET_TYPE, t.type),
        statusText: label(TICKET_STATUS, t.status),
        status: t.status,
        content: t.content,
        houseName: (t.house && (t.house.displayName || t.house.code)) || '',
        houseId: t.houseId,
        assignee: t.assigneeName || '',
        reply: t.replyContent || '',
        at: fmtDateTimeSec(t.createdAt),
      }));
      this.setData({
        pending: rows.filter((r) => r.status === 'PENDING'),
        processing: rows.filter((r) => r.status === 'PROCESSING'),
        done: rows.filter((r) => r.status !== 'PENDING' && r.status !== 'PROCESSING'),
      });
      this.showPage();
    } catch (e) {
      this.setData({ loadError: true });
    } finally {
      this.setData({ loading: false });
    }
  },

  toggleDone() {
    this.setData({ showDone: !this.data.showDone });
  },
  pickStatus(e){this.setData({selectedStatus:e.currentTarget.dataset.status,page:1});this.showPage();},
  showPage(){const rows=this.data.selectedStatus==='PENDING'?this.data.pending:this.data.selectedStatus==='PROCESSING'?this.data.processing:this.data.done;const pages=Math.max(1,Math.ceil(rows.length/20)),page=Math.min(this.data.page,pages);this.setData({pages,page,visibleRows:pageSlice(rows,page)});},
  turn(e){const page=this.data.page+Number(e.currentTarget.dataset.delta);if(page<1||page>this.data.pages)return;this.setData({page});this.showPage();wx.pageScrollTo({scrollTop:0,duration:0});},
  open(e){wx.navigateTo({url:'/packageAdmin/pages/ticket-detail/ticket-detail?id='+encodeURIComponent(e.currentTarget.dataset.id)});},

  async accept(e) {
    const { id, name } = e.currentTarget.dataset;
    const me = currentAdmin();
    const who = await ask('派给谁处理', '业主会看到这个名字', (me && me.name) || '');
    if (!who) return;
    this.setData({ busy: id });
    try {
      await adminRequest(`/admin/tickets/${id}/process`, { method: 'POST', data: { assigneeName: who } });
      wx.showToast({ title: `已受理:${who}`, icon: 'none' });
      await this.load();
    } finally {
      this.setData({ busy: '' });
    }
  },

  async finish(e) {
    const { id } = e.currentTarget.dataset;
    const reply = await ask('办结回复', '业主会看到这段话,并可以评分', '');
    if (!reply) return;
    this.setData({ busy: id });
    try {
      await adminRequest(`/admin/tickets/${id}/done`, { method: 'POST', data: { replyContent: reply } });
      wx.showToast({ title: '已办结,业主可见回复', icon: 'none' });
      await this.load();
    } finally {
      this.setData({ busy: '' });
    }
  },

  goHouse(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/packageAdmin/pages/house/house?id=${id}` });
  },
  },
});

/** 带输入的确认框:空输入等于取消(两个接口都要求非空,提前挡住) */
function ask(title, placeholder, value) {
  return new Promise((resolve) =>
    wx.showModal({
      title,
      editable: true,
      placeholderText: placeholder,
      content: value,
      success: (r) => resolve(r.confirm && r.content && r.content.trim() ? r.content.trim() : ''),
      fail: () => resolve(''),
    }),
  );
}
