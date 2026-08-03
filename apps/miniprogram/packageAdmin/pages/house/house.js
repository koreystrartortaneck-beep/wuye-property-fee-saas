const { adminRequest } = require('../../../utils/admin');
const { periodLabel } = require('../../../utils/labels');

/*
 * 房屋详情 —— 管理端的核心一屏:这套房的一切,以及现场要做的动作。
 *
 * 布局按物业接电话的顺序:欠多少(大字)→ 谁住(手机号,可换)→ 账单历史。
 * 换住户 = 删旧号 + 加新号,和电脑后台同一套接口、同一套联动
 * (删号即时解绑,结果如实弹出「已同时解除 N 人的绑定」)。
 */

const BILL_STATUS = { UNPAID: '待缴', PAID: '已缴', CANCELED: '已作废', DRAFT: '草稿', REFUNDING: '退款中', REFUNDED: '已退款' };

Page({
  data: {
    id: '',
    loading: true,
    loadError: false,
    house: null,
    summary: null,
    bills: [],
    contacts: [],
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
      const [profile, contacts] = await Promise.all([
        adminRequest(`/admin/house-profile/${this.data.id}`, { silent: true }),
        adminRequest(`/admin/houses/${this.data.id}/contacts`, { silent: true }),
      ]);
      this.setData({
        house: profile.house,
        summary: profile.summary,
        bills: (profile.bills || []).slice(0, 20).map((b) => ({
          ...b,
          statusLabel: BILL_STATUS[b.status] || b.status,
          periodText: periodLabel(b.period),
        })),
        contacts: contacts.items || [],
      });
    } catch (e) {
      this.setData({ loadError: true });
    } finally {
      this.setData({ loading: false });
    }
  },

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

  callPhone(e) {
    const phone = e.currentTarget.dataset.phone;
    if (phone) wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },
});
