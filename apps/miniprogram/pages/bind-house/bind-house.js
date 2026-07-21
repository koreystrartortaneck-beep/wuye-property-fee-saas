const config = require('../../config');
const { request } = require('../../utils/request');
const { bindPhone, loadMyHouses } = require('../../utils/auth');

Page({
  data: {
    mockAuth: config.mockAuth, // true=输入手机号；false=微信授权按钮
    phone: '',
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
    await loadMyHouses();
    wx.hideLoading();
    if (res.matchedHouses > 0) {
      wx.showToast({ title: `已自动绑定 ${res.matchedHouses} 处房产`, icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 1200);
    } else {
      wx.showToast({ title: '未匹配到登记房产，请在下方申请绑定', icon: 'none', duration: 2500 });
    }
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
