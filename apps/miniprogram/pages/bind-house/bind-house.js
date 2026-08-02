const config = require('../../config');
const { request } = require('../../utils/request');
const { bindPhone, loadMyHouses } = require('../../utils/auth');

/** 输入即搜的防抖间隔。太短等于不防抖，太长会让人以为没反应 */
const DEBOUNCE_MS = 300;

Page({
  _kwTimer: null,
  _houseTimer: null,
  /** 请求序号：只认最后一次搜索的结果，防止先发后到的响应覆盖新结果 */
  _kwTicket: 0,
  _houseTicket: 0,

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
    communityTotal: 0,
    /** 被截断掉的条数。>0 时界面必须说出来，见 wxml 里的注释 */
    communityMore: 0,
    searching: false,
    selectedCommunity: null,
    houseKeyword: '',
    houses: [],
    houseTotal: 0,
    houseMore: 0,
    houseSearching: false,
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

  /*
   * 输入即搜。原来是「输入 + 点搜索按钮」，那颗按钮既难看又把输入框挤窄。
   *
   * 防抖 300ms 是必须的：不防抖就是每敲一个字发一次请求，
   * 打「金港城」发三次，返回还可能乱序 —— 后到的那次覆盖先到的，
   * 结果和最后输入的关键词对不上。ticket 递增就是防这个。
   */
  onKeywordInput(e) {
    const keyword = e.detail.value;
    this.setData({ keyword });
    clearTimeout(this._kwTimer);
    if (!keyword.trim()) {
      this.setData({ communities: [], communityTotal: 0, communityMore: 0, searching: false });
      return;
    }
    this._kwTimer = setTimeout(() => this.searchCommunities(), DEBOUNCE_MS);
  },

  /** 方式二：搜索小区 → 选房号 → 提交申请 */
  async searchCommunities() {
    const keyword = this.data.keyword.trim();
    if (!keyword) return;
    const ticket = ++this._kwTicket;
    this.setData({ searching: true });
    try {
      const res = await request(`/owner/communities?keyword=${encodeURIComponent(keyword)}`);
      if (ticket !== this._kwTicket) return; // 已有更新的一次搜索在飞，丢弃这次的结果
      const items = res.items || [];
      this.setData({
        communities: items,
        communityTotal: res.total || items.length,
        communityMore: Math.max(0, (res.total || items.length) - items.length),
      });
    } finally {
      if (ticket === this._kwTicket) this.setData({ searching: false });
    }
  },

  async pickCommunity(e) {
    const community = this.data.communities[e.currentTarget.dataset.index];
    this.setData({ selectedCommunity: community, houseKeyword: '', selectedHouse: null });
    await this.searchHouses();
  },

  /** 退回小区选择。原来选错了没有任何出路，只能退出页面重进 */
  resetCommunity() {
    clearTimeout(this._houseTimer);
    this.setData({
      selectedCommunity: null,
      houseKeyword: '',
      houses: [],
      houseTotal: 0,
      houseMore: 0,
      selectedHouse: null,
    });
  },

  onHouseKeywordInput(e) {
    this.setData({ houseKeyword: e.detail.value });
    clearTimeout(this._houseTimer);
    this._houseTimer = setTimeout(() => this.searchHouses(), DEBOUNCE_MS);
  },

  async searchHouses() {
    const { selectedCommunity, houseKeyword } = this.data;
    if (!selectedCommunity) return;
    const ticket = ++this._houseTicket;
    this.setData({ houseSearching: true });
    try {
      // 查询串单独拼：路径模板要保持成一条能与后端路由对上的字面路径
      const query = houseKeyword.trim() ? `?keyword=${encodeURIComponent(houseKeyword.trim())}` : '';
      const res = await request(`/owner/communities/${selectedCommunity.id}/houses` + query);
      if (ticket !== this._houseTicket) return;
      const items = res.items || [];
      this.setData({
        houses: items,
        houseTotal: res.total || items.length,
        houseMore: Math.max(0, (res.total || items.length) - items.length),
      });
    } finally {
      if (ticket === this._houseTicket) this.setData({ houseSearching: false });
    }
  },

  pickHouse(e) {
    this.setData({ selectedHouse: this.data.houses[e.currentTarget.dataset.index] });
  },

  onUnload() {
    // 页面关了定时器还在跑 → setData 打到已销毁的页面上
    clearTimeout(this._kwTimer);
    clearTimeout(this._houseTimer);
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
