const { adminRequest } = require('../../../utils/admin');

/*
 * 发公告(手机端)。
 *
 * 公告是**发出去就人人可见**的,没有草稿态 —— 所以发布前给一次确认,
 * 并如实说清受众范围。写错了可以撤回(列表里每条都能撤),
 * 但业主可能已经看过,撤回不是撤销。
 */

Page({
  data: {
    communityId: '',
    title: '',
    content: '',
    pinned: false,
    /** 范围:本小区 / 全部小区(多小区物业公司才有区别) */
    allCommunities: false,
    sending: false,
    list: [],
    loading: true,
  },

  onLoad(q) {
    this.setData({ communityId: q.communityId || '' });
  },

  onShow() {
    void this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const d = await adminRequest('/admin/announcements?page=1&pageSize=20', { silent: true });
      this.setData({
        list: (d.list || []).map((a) => ({
          id: a.id,
          title: a.title,
          pinned: a.pinned,
          status: a.status,
          statusLabel: a.status === 'PUBLISHED' ? '已发布' : '已撤回',
          scope: a.communityId ? '本小区' : '全部小区',
          at: (a.publishedAt || a.createdAt || '').slice(0, 10),
        })),
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  onTitle(e) {
    this.setData({ title: e.detail.value });
  },
  onContent(e) {
    this.setData({ content: e.detail.value });
  },
  togglePinned() {
    this.setData({ pinned: !this.data.pinned });
  },
  toggleScope() {
    this.setData({ allCommunities: !this.data.allCommunities });
  },

  async send() {
    const title = this.data.title.trim();
    const content = this.data.content.trim();
    if (!title) return wx.showToast({ title: '请填写标题', icon: 'none' });
    if (!content) return wx.showToast({ title: '请填写内容', icon: 'none' });

    const scope = this.data.allCommunities ? '本公司全部小区' : '本小区';
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '发布公告',
        content: `发布后${scope}的业主立即能在小程序看到。确认发布?`,
        confirmText: '发布',
        success: (r) => resolve(r.confirm),
        // 弹窗失败(文案超长/已有弹窗在显示)也必须把 Promise 收掉,否则界面永久卡在「处理中」
        fail: () => resolve(false),
      }),
    );
    if (!ok) return;

    this.setData({ sending: true });
    try {
      const body = { title, content, pinned: this.data.pinned };
      // 不传 communityId = 公司全部小区(后端约定)
      if (!this.data.allCommunities && this.data.communityId) body.communityId = this.data.communityId;
      await adminRequest('/admin/announcements', { method: 'POST', data: body });
      wx.showToast({ title: '已发布', icon: 'success' });
      this.setData({ title: '', content: '', pinned: false });
      await this.load();
    } finally {
      this.setData({ sending: false });
    }
  },

  async revoke(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '撤回公告',
        content: '撤回后业主不再看到这条公告。已经看过的人无法收回。',
        confirmText: '撤回',
        confirmColor: '#c45656',
        success: (r) => resolve(r.confirm),
        // 弹窗失败(文案超长/已有弹窗在显示)也必须把 Promise 收掉,否则界面永久卡在「处理中」
        fail: () => resolve(false),
      }),
    );
    if (!ok) return;
    await adminRequest(`/admin/announcements/${id}`, { method: 'PATCH', data: { status: 'REVOKED' } });
    wx.showToast({ title: '已撤回', icon: 'none' });
    await this.load();
  },
});
