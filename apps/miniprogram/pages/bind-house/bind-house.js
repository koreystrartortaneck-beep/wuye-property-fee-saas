const config = require('../../config');
const { request } = require('../../utils/request');
const { bindPhone, loadMyHouses } = require('../../utils/auth');

Page({
  data: {
    mockAuth: config.mockAuth, // true=输入手机号；false=微信授权按钮
    phone: '',
    /*
     * 手机号是否已绑定。这个页面必须知道这件事：
     * 业主实测指出「我已经绑定了手机号，还是有这个按钮」——
     * 对已绑定的人显示「微信授权手机号」，读起来像上次没绑上，
     * 他会疑惑要不要再点一次。
     * 已绑定时按钮的真实用途只剩一个：物业**补录**了他的号码之后重新匹配 ——
     * 文案就该说这个。
     */
    hasPhone: false,
    maskedPhone: '',
    keyword: '',
    communities: [],
    selectedCommunity: null,
    houses: [],
    selectedHouse: null,
    applicantName: '',
    relationIndex: 0,
    relations: [
      { value: 'OWNER', label: '业主' },
      { value: 'FAMILY', label: '家属' },
      { value: 'TENANT', label: '租客' },
    ],
    submitting: false,
  },

  async onShow() {
    await getApp().loginReady;
    await this.refreshPhoneState();
  },

  /** 读手机号绑定状态。onShow 与「刚授权完」都要用 —— 后者原来漏了刷新 */
  async refreshPhoneState() {
    try {
      const me = await request('/auth/me', { silent: true });
      this.setData({ hasPhone: !!me.hasPhone, maskedPhone: me.phone || '' });
    } catch (e) {
      // 读不到就按未绑定展示，按钮功能不受影响
    }
  },

  onPhoneInput(e) {
    this.setData({ phone: e.detail.value });
  },

  /** 方式一(mock)：手动输入手机号自动匹配 */
  async matchByPhone() {
    const phone = this.data.phone.trim();
    if (!/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '请输入 11 位手机号', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '匹配中' });
    try {
      const res = await bindPhone(phone);
      await this.afterBind(res);
    } catch (e) {
      wx.hideLoading();
    }
  },

  /** 方式一(real)：微信手机号快速验证按钮回调（e.detail.code） */
  async onGetPhone(e) {
    const code = e.detail && e.detail.code;
    if (!code) {
      wx.showToast({ title: '需授权手机号才能自动匹配', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '匹配中' });
    try {
      const res = await bindPhone(code);
      await this.afterBind(res);
    } catch (err) {
      wx.hideLoading();
    }
  },

  async afterBind(res) {
    const houses = await loadMyHouses();
    wx.hideLoading();
    if (res.matchedHouses > 0) {
      wx.showToast({ title: `已自动绑定 ${res.matchedHouses} 处房屋`, icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 1200);
      return;
    }
    /*
     * 没匹配到房屋 ≠ 授权失败。
     *
     * 原文案是「未匹配到登记房屋，请在下方申请绑定」—— 手机号其实已经绑上了
     * （物业从此能联系到你），这句话却让人以为整件事失败了。
     * 而对**已经有房屋**的业主更莫名其妙：让他去「申请绑定」他已经绑好的房。
     * 2026-08-01 实测撞到这一幕。
     *
     * 所以先肯定已完成的那件事，再按他有没有房屋给出不同的下一步。
     */
    if (houses.length > 0) {
      await this.refreshPhoneState();
      wx.showToast({ title: '手机号已绑定，物业可联系到您', icon: 'none', duration: 2500 });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 1600);
      return;
    }
    /*
     * 文案精简：原来 4 行 60 余字，业主指出「太长了」。
     * 他只需要知道两件事 —— 为什么没匹配上、下一步做什么。
     * 其余解释（物业登记的是买房时的号码之类）属于背景，删掉。
     *
     * 关掉弹窗后必须刷新本页：手机号**已经绑上了**，
     * 卡片标题该从「手机号快速绑定」变成「按手机号匹配房屋」。
     * 原来不刷新，业主关掉弹窗看到的还是「微信授权手机号」——
     * 刚做完的事在界面上没有任何痕迹，会以为白点了。
     */
    await new Promise((resolve) =>
      wx.showModal({
        title: '手机号已绑定',
        content: '物业未登记此号码，请在下方申请绑定房屋。',
        showCancel: false,
        confirmText: '知道了',
        complete: resolve,
      }),
    );
    await this.refreshPhoneState();
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  /** 方式二：搜索小区 → 选房号 → 提交申请 */
  async searchCommunities() {
    const list = await request(`/owner/communities?keyword=${encodeURIComponent(this.data.keyword)}`);
    this.setData({ communities: list, selectedCommunity: null, houses: [], selectedHouse: null });
    if (list.length === 0) wx.showToast({ title: '未找到小区', icon: 'none' });
  },

  async pickCommunity(e) {
    const community = this.data.communities[e.currentTarget.dataset.index];
    const houses = await request(`/owner/communities/${community.id}/houses`);
    this.setData({ selectedCommunity: community, houses, selectedHouse: null });
  },

  pickHouse(e) {
    this.setData({ selectedHouse: this.data.houses[e.currentTarget.dataset.index] });
  },

  onNameInput(e) {
    this.setData({ applicantName: e.detail.value });
  },

  onRelationChange(e) {
    this.setData({ relationIndex: Number(e.detail.value) });
  },

  async submitApply() {
    const { selectedHouse, applicantName, relations, relationIndex, submitting } = this.data;
    if (submitting) return;
    if (!selectedHouse) {
      wx.showToast({ title: '请先选择房号', icon: 'none' });
      return;
    }
    if (!applicantName.trim()) {
      wx.showToast({ title: '请填写姓名', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await request('/owner/bindings', {
        method: 'POST',
        data: {
          houseId: selectedHouse.id,
          relation: relations[relationIndex].value,
          applicantName: applicantName.trim(),
        },
      });
      wx.showModal({
        title: '申请已提交',
        content: '物业审核通过后即可查看账单',
        showCancel: false,
        success: () => wx.switchTab({ url: '/pages/index/index' }),
      });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
