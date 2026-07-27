const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');
const labels = require('../../utils/labels');
const STATUS_LABEL = labels.USER_COUPON_STATUS;
const TYPE_LABEL = labels.COUPON_TYPE;


function fmtValue(c) {
  if (c.type === 'DISCOUNT') {
    return { big: Number(c.faceValue || 0).toFixed(0), sub: `满${Number(c.threshold || 0).toFixed(0)}可用` };
  }
  return { big: c.faceValue ? Number(c.faceValue).toFixed(0) : '券', sub: TYPE_LABEL[c.type] };
}

Page({
  data: {
    tab: 0, // 0 可领取 1 我的
    available: [],
    mine: [],
    // 三态：此前加载中 / 网络失败 / 未绑房都被渲染成「暂无可领取优惠券」，
    // 用户无法分辨到底是没有券还是页面坏了。
    loading: true,
    error: false,
    noHouse: false,
    claiming: '',
  },

  async onShow() {
    this.setData({ loading: true, error: false });
    try {
      await getApp().loginReady;
      const houses = await loadMyHouses().catch(() => []);
      const house = getApp().globalData.currentHouse;
      if (!houses.length || !house) {
        this.setData({ noHouse: true, loading: false, available: [], mine: [] });
        return;
      }
      this.setData({ noHouse: false });
      await this.loadAvailable();
      if (this.data.tab === 1) await this.loadMine();
      this.setData({ loading: false });
    } catch (e) {
      this.setData({ loading: false, error: true });
    }
  },

  async retry() {
    await this.onShow();
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind-house/bind-house' });
  },

  async loadAvailable() {
    const house = getApp().globalData.currentHouse;
    if (!house) {
      this.setData({ available: [] });
      return;
    }
    const list = await request(`/owner/coupons?houseId=${house.houseId}`);
    this.setData({
      available: list.map((c) => {
        const v = fmtValue(c);
        return {
          id: c.id,
          name: c.name,
          typeLabel: TYPE_LABEL[c.type],
          big: v.big,
          sub: v.sub,
          desc: c.description || '',
          validTo: (c.validTo || '').slice(0, 10),
          remaining: c.remaining,
          claimedByMe: c.claimedByMe,
          soldOut: c.remaining <= 0,
        };
      }),
    });
  },

  async loadMine() {
    const res = await request('/owner/my/coupons?pageSize=50');
    this.setData({
      mine: res.list.map((uc) => {
        const v = fmtValue(uc.coupon);
        return {
          id: uc.id,
          code: uc.code,
          name: uc.coupon.name,
          big: v.big,
          sub: v.sub,
          desc: uc.coupon.description || '',
          validTo: (uc.coupon.validTo || '').slice(0, 10),
          status: uc.status,
          statusLabel: STATUS_LABEL[uc.status] || uc.status,
        };
      }),
    });
  },

  async switchTab(e) {
    const tab = Number(e.currentTarget.dataset.tab);
    this.setData({ tab });
    if (tab === 1) await this.loadMine();
    else await this.loadAvailable();
  },

  async claim(e) {
    const id = e.currentTarget.dataset.id;
    // 防连点：perUserLimit > 1 时连点会重复领取
    if (this.data.claiming) return;
    this.setData({ claiming: id });
    try {
      const uc = await request(`/owner/coupons/${id}/claim`, { method: 'POST' });
      wx.showModal({
        title: '领取成功',
        content: `券码 ${uc.code}\n在「我的卡券」查看，使用时向物业出示`,
        showCancel: false,
      });
      await this.loadAvailable();
    } catch (err) {
      // 错误已由 request 统一提示
    } finally {
      this.setData({ claiming: '' });
    }
  },

  copyCode(e) {
    wx.setClipboardData({ data: e.currentTarget.dataset.code });
  },
});
