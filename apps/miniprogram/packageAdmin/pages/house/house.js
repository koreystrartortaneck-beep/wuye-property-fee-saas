const { adminRequest } = require('../../../utils/admin');
const { periodLabel } = require('../../../utils/labels');

/*
 * 房屋详情 —— 管理端的核心一屏:这套房的一切,以及现场要做的动作。
 *
 * 实测反馈:「我选中某一个,点进去之后应该是只给这一户编辑+发账单,现在非常混乱」。
 * 所以这一页是**单户作业台**,进来之后所有动作都只作用于这一户:
 *   欠多少(大字)→ 房屋信息(面积/放户日期,可改)→ 收费标准(挂哪条,可换)
 *   → 谁能看到账单(手机号,可换)→ 账单历史 → 给这一户出账单
 *
 * 「范围」这件事在这一页不存在:不给选楼栋、不给选全部。
 * 批量出账在首页底部的「发账单」,两条路各自笔直。
 */

const BILL_STATUS = { UNPAID: '待缴', PAID: '已缴', CANCELED: '已作废', DRAFT: '草稿', REFUNDING: '退款中', REFUNDED: '已退款' };
const MONTH = ['', '1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月'];

/** 标准的计价口径,给人看的一句话 */
function priceText(rule) {
  const p = rule.params || {};
  if (rule.ruleType === 'AREA_PRICE') return `${p.unitPrice} 元/㎡/月`;
  if (rule.ruleType === 'FIXED') return `固定 ${p.amount} 元`;
  if (rule.ruleType === 'METER') return `按抄表 ${p.unitPrice} 元/单位`;
  return '按公摊';
}

Page({
  data: {
    id: '',
    loading: true,
    loadError: false,
    house: null,
    summary: null,
    bills: [],
    contacts: [],
    /** 收费标准挂接 */
    standards: [],
    rules: [],
    pickingRule: false,
    /** 每年出账月份的人话 */
    billMonthText: '',
    /** 编辑房屋信息 */
    editing: false,
    form: { displayName: '', area: '', handoverDate: '', status: 'ACTIVE' },
    saving: false,
    /** 加号表单 */
    newPhone: '',
    newName: '',
    adding: false,
  },

  onLoad(query) {
    this.setData({ id: query.id });
  },

  onShow() {
    void this.load();
  },

  async load() {
    this.setData({ loading: true, loadError: false });
    try {
      const [profile, contacts, standards] = await Promise.all([
        adminRequest(`/admin/house-profile/${this.data.id}`, { silent: true }),
        adminRequest(`/admin/houses/${this.data.id}/contacts`, { silent: true }),
        adminRequest(`/admin/houses/${this.data.id}/standards`, { silent: true }),
      ]);
      /*
       * 放户日期两处都能给:/standards 一直有,/house-profile 是这次新加的。
       * 优先取前者 —— 后端还没部署完时若只认 profile,页面会对着一个填好的
       * 放户日期显示「未填」。界面说谎比报错严重(这是同一个坑的第三次)。
       */
      const anchor = (standards.house && standards.house.handoverDate
        ? String(standards.house.handoverDate).slice(0, 10)
        : '') || profile.house.handoverDate || '';
      const house = { ...profile.house, handoverDate: anchor };
      this.setData({
        house,
        summary: profile.summary,
        billMonthText: anchor ? `每年 ${MONTH[Number(anchor.slice(5, 7))]}出账` : '没填放户日期,出不了账',
        bills: (profile.bills || []).slice(0, 20).map((b) => ({
          ...b,
          statusLabel: BILL_STATUS[b.status] || b.status,
          periodText: periodLabel(b.period),
        })),
        contacts: contacts.items || [],
        standards: (standards.items || [])
          .filter((s) => s.status === 'ACTIVE')
          .map((s) => ({
            ruleId: s.ruleId,
            name: s.rule.name,
            price: priceText(s.rule),
            // 挂接自带 startDate 时,锚点是它而不是房屋的放户日期
            anchorText: s.startDate ? `账期锚点 ${String(s.startDate).slice(0, 10)}` : '',
          })),
        form: {
          displayName: house.displayName,
          area: house.area || '',
          handoverDate: house.handoverDate || '',
          status: house.status,
        },
      });
    } catch (e) {
      this.setData({ loadError: true });
    } finally {
      this.setData({ loading: false });
    }
  },

  /* ── 编辑房屋信息 ── */
  startEdit() {
    this.setData({ editing: true });
  },
  cancelEdit() {
    const h = this.data.house;
    this.setData({
      editing: false,
      form: { displayName: h.displayName, area: h.area || '', handoverDate: h.handoverDate || '', status: h.status },
    });
  },
  onFormInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.k}`]: e.detail.value });
  },
  onHandover(e) {
    this.setData({ 'form.handoverDate': e.detail.value });
  },
  pickStatus(e) {
    this.setData({ 'form.status': e.currentTarget.dataset.v });
  },

  async saveHouse() {
    const f = this.data.form;
    const h = this.data.house;
    if (!f.displayName.trim()) return wx.showToast({ title: '房号不能为空', icon: 'none' });
    const area = String(f.area).trim();
    if (area && !(Number(area) > 0)) return wx.showToast({ title: '面积要是大于 0 的数', icon: 'none' });
    /*
     * 只发真改了的字段。全字段回写会把「没动的值」也算成一次修改,
     * 审计里堆满假变更,真正改过面积的那一次就淹了。
     */
    const patch = {};
    if (f.displayName.trim() !== h.displayName) patch.displayName = f.displayName.trim();
    if (area && area !== String(h.area || '')) patch.area = Number(area);
    if (f.handoverDate !== (h.handoverDate || '')) patch.handoverDate = f.handoverDate;
    if (f.status !== h.status) patch.status = f.status;
    if (Object.keys(patch).length === 0) {
      this.setData({ editing: false });
      return;
    }
    /*
     * 面积和放户日期直接决定账单金额与出账月份。改之前把后果说全 ——
     * 现场改数据的人未必知道「放户日期」是出账依据。
     */
    if (patch.area || patch.handoverDate) {
      const ok = await new Promise((resolve) =>
        wx.showModal({
          title: '确认修改',
          content: [
            patch.area ? `面积改为 ${patch.area} ㎡(以后出账按新面积算)` : '',
            patch.handoverDate ? `放户日期改为 ${patch.handoverDate}(以后每年在这个月出账)` : '',
            '已经出过的账单金额不变。',
          ]
            .filter(Boolean)
            .join('\n'),
          confirmText: '保存',
          success: (r) => resolve(r.confirm),
        }),
      );
      if (!ok) return;
    }
    this.setData({ saving: true });
    try {
      await adminRequest(`/admin/houses/${this.data.id}`, { method: 'PATCH', data: patch });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ editing: false });
      await this.load();
    } finally {
      this.setData({ saving: false });
    }
  },

  /* ── 收费标准挂接 ── */
  async togglePickRule() {
    const open = !this.data.pickingRule;
    this.setData({ pickingRule: open });
    if (!open || this.data.rules.length > 0) return;
    const d = await adminRequest(
      `/admin/fee-rules?communityId=${this.data.house.communityId}&pageSize=100`,
      { silent: true },
    );
    const attached = new Set(this.data.standards.map((s) => s.ruleId));
    this.setData({
      rules: (d.list || [])
        .filter((r) => r.periodScheme === 'ANNIVERSARY' && r.enabled && !attached.has(r.id))
        .map((r) => ({ id: r.id, name: r.name, price: priceText(r) })),
    });
  },

  async attachRule(e) {
    const r = this.data.rules[e.currentTarget.dataset.i];
    await adminRequest(`/admin/houses/${this.data.id}/standards`, { method: 'POST', data: { ruleId: r.id } });
    wx.showToast({ title: '已挂上,下次出账按它算', icon: 'none', duration: 2200 });
    this.setData({ pickingRule: false, rules: [] });
    await this.load();
  },

  async detachRule(e) {
    const { id, name } = e.currentTarget.dataset;
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '摘除收费标准',
        content: `摘除「${name}」后,这户以后不再按它出账(空置/免收就该摘)。已经出过的账单不动。`,
        confirmText: '摘除',
        confirmColor: '#c45656',
        success: (r) => resolve(r.confirm),
      }),
    );
    if (!ok) return;
    await adminRequest(`/admin/houses/${this.data.id}/standards/${id}`, { method: 'DELETE' });
    wx.showToast({ title: '已摘除', icon: 'none' });
    this.setData({ rules: [] });
    await this.load();
  },

  /* ── 授权手机号 ── */
  onPhoneInput(e) {
    this.setData({ newPhone: e.detail.value });
  },
  onNameInput(e) {
    this.setData({ newName: e.detail.value });
  },

  async addContact() {
    const phone = this.data.newPhone.trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      wx.showToast({ title: '请输入 11 位手机号', icon: 'none' });
      return;
    }
    if (this.data.adding) return;
    this.setData({ adding: true });
    try {
      const r = await adminRequest(`/admin/houses/${this.data.id}/contacts`, {
        method: 'POST',
        data: { phone, name: this.data.newName.trim() || undefined },
      });
      wx.showToast({
        title: r.activatedBindings > 0 ? '已添加,对方已绑定' : '已添加,对方授权后可见账单',
        icon: 'none',
        duration: 2500,
      });
      this.setData({ newPhone: '', newName: '' });
      await this.load();
    } finally {
      this.setData({ adding: false });
    }
  },

  async removeContact(e) {
    const { id, phone } = e.currentTarget.dataset;
    /*
     * 删号是权限撤销(对方立刻看不到账单),现场操作给一次确认 ——
     * 手机上误触比电脑鼠标高一个数量级,这一下不是「防护」是防手滑。
     */
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '移除授权',
        content: `移除 ${phone} 后,该手机号对应的用户将立即看不到本房账单。`,
        confirmText: '移除',
        confirmColor: '#c45656',
        success: (r) => resolve(r.confirm),
      }),
    );
    if (!ok) return;
    const r = await adminRequest(`/admin/house-contacts/${id}`, { method: 'DELETE' });
    wx.showToast({
      title: r.revokedBindings.length > 0 ? `已移除,同时解除 ${r.revokedBindings.length} 人绑定` : '已移除',
      icon: 'none',
      duration: 2500,
    });
    await this.load();
  },

  /** 只给这一户出账单:单户页面,不再回到批量流程里选范围 */
  goBillThisHouse() {
    const h = this.data.house;
    if (!h) return;
    wx.navigateTo({ url: `/packageAdmin/pages/bill-one/bill-one?id=${h.id}` });
  },

  callPhone(e) {
    const phone = e.currentTarget.dataset.phone;
    if (phone) wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },
});
