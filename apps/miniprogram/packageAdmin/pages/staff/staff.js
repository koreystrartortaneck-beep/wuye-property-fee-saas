const { adminRequest, currentAdmin } = require('../../../utils/admin');

/*
 * 员工与权限 —— 物业自己加人、自己停用。
 *
 * 为什么它比看起来重要:在这一页之前,整个公司只有一个能用的管理账号
 * (AdminUser.phone 是唯一的),也就是只有一个人能用手机进管理端。
 * 收费员上岗没入口,离职更没有 —— 他的手机号一直留在名单里。
 *
 * 两个角色,一句话的差别:
 *   物业管理员 —— 什么都能做,含退款、整批作废、彻底删房
 *   收费员     —— 日常收钱/催缴/出账/报修;动钱的三件事做不了
 *
 * 界面上必须说清的三件事(都是实测里人会卡住的地方):
 *   ① 初始密码只显示这一次 —— 关掉就再也看不到,只能重置
 *   ② 填了手机号也不能立刻手机登录:得先在电脑后台用初始密码登录一次改密
 *      (免密通道会拒绝「须改密」的受限会话)
 *   ③ 停用是即时的:他手里的令牌当场失效,不用等 12 小时
 */

const ROLES = [
  { v: 'STAFF', label: '收费员', desc: '收钱 / 催缴 / 出账 / 报修 —— 退款与整批作废做不了' },
  { v: 'TENANT_ADMIN', label: '物业管理员', desc: '什么都能做,包括退款、整批作废、彻底删房' },
];

Page({
  data: {
    loading: true,
    loadError: false,
    items: [],
    me: null,
    roles: ROLES,
    /** 新建表单 */
    adding: false,
    form: { username: '', name: '', role: 'STAFF', phone: '' },
    saving: false,
    busy: '',
  },

  onShow() {
    this.setData({ me: currentAdmin() });
    void this.load();
  },

  async load() {
    this.setData({ loading: true, loadError: false });
    try {
      const d = await adminRequest('/admin/staff', { silent: true });
      this.setData({
        items: (d.items || []).map((x) => ({
          ...x,
          // 「他为什么登不上」得能一眼看出来,而不是靠猜
          blockedReason: x.status !== 'ACTIVE'
            ? '已停用'
            : x.mustChangePassword
              ? '待首次改密(还不能手机登录)'
              : x.lockedUntil && new Date(x.lockedUntil) > new Date()
                ? '密码连错被临时锁定'
                : '',
        })),
      });
    } catch (e) {
      this.setData({ loadError: true });
    } finally {
      this.setData({ loading: false });
    }
  },

  toggleAdd() {
    this.setData({ adding: !this.data.adding });
  },
  onInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.k}`]: e.detail.value });
  },
  pickRole(e) {
    this.setData({ 'form.role': e.currentTarget.dataset.v });
  },

  async create() {
    const f = this.data.form;
    if (this.data.saving) return;
    if (!/^[a-zA-Z0-9._-]{3,}$/.test(f.username.trim())) {
      return wx.showToast({ title: '登录名 ≥3 位,只能用字母数字和 . _ -', icon: 'none', duration: 2500 });
    }
    if (!f.name.trim()) return wx.showToast({ title: '请填姓名', icon: 'none' });
    const phone = f.phone.trim();
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) return wx.showToast({ title: '手机号是 11 位', icon: 'none' });

    this.setData({ saving: true });
    try {
      const r = await adminRequest('/admin/staff', {
        method: 'POST',
        data: { username: f.username.trim(), name: f.name.trim(), role: f.role, phone: phone || undefined },
      });
      /*
       * 初始密码只显示这一次 —— 服务端不留明文。所以这个弹窗必须说清楚,
       * 并且不能只用 toast(一闪就没了,人还没抄下来)。
       */
      await new Promise((resolve) =>
        wx.showModal({
          title: '已建好,请抄下初始密码',
          content: `登录名 ${r.username}\n初始密码 ${r.password}\n\n这串密码只显示这一次(系统不留明文)。\n${r.hint}`,
          confirmText: '已抄下',
          showCancel: false,
          success: () => resolve(true),
          fail: () => resolve(true),
        }),
      );
      this.setData({ adding: false, form: { username: '', name: '', role: 'STAFF', phone: '' } });
      await this.load();
    } finally {
      this.setData({ saving: false });
    }
  },

  /** 停用 / 恢复:停用即时生效(令牌当场失效) */
  async toggleStatus(e) {
    const i = Number(e.currentTarget.dataset.i);
    const x = this.data.items[i];
    const disable = x.status === 'ACTIVE';
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: disable ? `停用 ${x.name}` : `恢复 ${x.name}`,
        content: disable
          ? '停用后他立刻进不了管理端(手里的登录状态当场失效),手机号也不再能免密进入。以后可以恢复。'
          : '恢复后他可以重新登录管理端。',
        confirmText: disable ? '停用' : '恢复',
        confirmColor: disable ? '#c45656' : '#3b2b57',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false),
      }),
    );
    if (!ok) return;
    await this.patch(x.id, { status: disable ? 'DISABLED' : 'ACTIVE' });
  },

  /** 换角色:管理员 ⇄ 收费员 */
  async switchRole(e) {
    const i = Number(e.currentTarget.dataset.i);
    const x = this.data.items[i];
    const to = x.role === 'TENANT_ADMIN' ? 'STAFF' : 'TENANT_ADMIN';
    const toLabel = to === 'TENANT_ADMIN' ? '物业管理员' : '收费员';
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: `改成${toLabel}`,
        content:
          to === 'TENANT_ADMIN'
            ? `${x.name} 将能做退款、整批作废、彻底删房这些动钱的事。`
            : `${x.name} 以后做不了退款、整批作废、彻底删房;日常收钱、催缴、出账、报修照旧。`,
        confirmText: '确认',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false),
      }),
    );
    if (!ok) return;
    await this.patch(x.id, { role: to });
  },

  /** 换手机号 / 摘掉手机号 */
  async setPhone(e) {
    const i = Number(e.currentTarget.dataset.i);
    const x = this.data.items[i];
    const typed = await new Promise((resolve) =>
      wx.showModal({
        title: `${x.name} 的手机号`,
        editable: true,
        placeholderText: x.phoneTail ? `当前 …${x.phoneTail};留空 = 取消免密登录` : '11 位手机号;留空 = 不设',
        confirmText: '保存',
        success: (r) => resolve(r.confirm ? (r.content || '').trim() : null),
        fail: () => resolve(null),
      }),
    );
    if (typed === null) return;
    if (typed && !/^1[3-9]\d{9}$/.test(typed)) return wx.showToast({ title: '手机号是 11 位', icon: 'none' });
    await this.patch(x.id, { phone: typed });
  },

  async resetPassword(e) {
    const i = Number(e.currentTarget.dataset.i);
    const x = this.data.items[i];
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: `重置 ${x.name} 的密码`,
        content: '会生成一串新的初始密码(只显示这一次),他手里的登录状态当场失效,下次登录必须改密。',
        confirmText: '重置',
        confirmColor: '#c45656',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false),
      }),
    );
    if (!ok) return;
    this.setData({ busy: x.id });
    try {
      const r = await adminRequest(`/admin/staff/${x.id}/reset-password`, { method: 'POST' });
      wx.showModal({
        title: '请抄下新密码',
        content: `登录名 ${r.username}\n新密码 ${r.password}\n\n只显示这一次。请他在电脑后台登录并改密。`,
        showCancel: false,
        confirmText: '已抄下',
      });
      await this.load();
    } finally {
      this.setData({ busy: '' });
    }
  },

  async patch(id, data) {
    this.setData({ busy: id });
    try {
      await adminRequest(`/admin/staff/${id}`, { method: 'PATCH', data });
      wx.showToast({ title: '已保存', icon: 'success' });
      await this.load();
    } finally {
      this.setData({ busy: '' });
    }
  },
});
