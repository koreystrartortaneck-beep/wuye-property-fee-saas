const { adminRequest, currentAdmin } = require('../../../utils/admin');
// 枚举文案一律取自 utils/labels(与后端枚举有守卫比对),页面不自建映射
const { TICKET_TYPE, TICKET_STATUS, label } = require('../../../utils/labels');

/*
 * 报事报修 —— 物业在现场用的一页。
 *
 * 顺序按现场逻辑排:待受理在最上面(业主在等),处理中其次,已办结折叠在下面。
 * 两个动作都要填字:
 *   受理 → 谁去处理(业主端会看到这个名字)
 *   办结 → 回复什么(业主端会看到这段话,而且他能评分)
 * 所以用 showModal 的可编辑输入,而不是「一键办结」——
 * 一键办结留下的是一条没人看得懂的记录,业主只会再报一次。
 */

Page({
  data: {
    loading: true,
    loadError: false,
    pending: [],
    processing: [],
    done: [],
    showDone: false,
    busy: '',
  },

  onShow() {
    void this.load();
  },

  async load() {
    this.setData({ loading: true, loadError: false });
    try {
      const d = await adminRequest('/admin/tickets?page=1&pageSize=50', { silent: true });
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
        at: String(t.createdAt || '').slice(0, 16).replace('T', ' '),
      }));
      this.setData({
        pending: rows.filter((r) => r.status === 'PENDING'),
        processing: rows.filter((r) => r.status === 'PROCESSING'),
        done: rows.filter((r) => r.status !== 'PENDING' && r.status !== 'PROCESSING'),
      });
    } catch (e) {
      this.setData({ loadError: true });
    } finally {
      this.setData({ loading: false });
    }
  },

  toggleDone() {
    this.setData({ showDone: !this.data.showDone });
  },

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
