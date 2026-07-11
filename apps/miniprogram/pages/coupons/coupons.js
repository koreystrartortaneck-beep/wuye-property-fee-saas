const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');

const TYPE_LABEL = { DISCOUNT: '满减', SERVICE: '服务券', GIFT: '礼品券' };
const STATUS_LABEL = { UNUSED: '未使用', USED: '已核销', EXPIRED: '已过期' };

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
  },

  async onShow() {
    await getApp().loginReady;
    await loadMyHouses().catch(() => []);
    await this.loadAvailable();
    if (this.data.tab === 1) await this.loadMine();
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
    }
  },

  copyCode(e) {
    wx.setClipboardData({ data: e.currentTarget.dataset.code });
  },
});
