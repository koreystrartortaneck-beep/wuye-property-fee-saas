const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');

const RELATION_LABEL = { OWNER: '业主', FAMILY: '家属', TENANT: '租客' };

Page({
  data: {
    userName: '业主',
    phone: '',
    avatarText: '宅',
    houses: [],
    pendingBindings: [],
    menus: [
      { key: 'houses', title: '我的房屋', desc: '绑定新房产或切换' },
      { key: 'payments', title: '缴费记录', desc: '查看历史付款凭证' },
      { key: 'notify', title: '消息提醒', desc: '出账与逾期自动推送' },
      { key: 'service', title: '联系客服', desc: '物业管家在线协助' },
    ],
  },

  async onShow() {
    const app = getApp();
    await app.loginReady;
    try {
      const [me, houses, bindings] = await Promise.all([
        request('/auth/me'),
        loadMyHouses(),
        request('/owner/my/bindings'),
      ]);
      const current = app.globalData.currentHouse;
      // 审核中 / 被驳回的申请
      const pendingBindings = bindings
        .filter((b) => b.status !== 'ACTIVE')
        .map((b) => ({
          id: b.id,
          communityName: b.communityName,
          displayName: b.displayName,
          statusLabel: b.status === 'PENDING' ? '审核中' : '已驳回',
          rejected: b.status === 'REJECTED',
          rejectReason: b.rejectReason || '',
        }));
      this.setData({
        pendingBindings,
        phone: me.phone ? me.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '未绑定手机号',
        userName: houses.length > 0 ? `${houses[0].communityName}业主` : '业主',
        houses: houses.map((h) => ({
          houseId: h.houseId,
          communityName: h.communityName,
          displayName: h.displayName,
          tag: RELATION_LABEL[h.relation] || h.relation,
          active: current && current.houseId === h.houseId,
        })),
      });
    } catch (e) {
      console.error(e);
    }
  },

  /** 点房屋卡片 → 设为当前房屋 */
  pickHouse(e) {
    const houseId = e.currentTarget.dataset.id;
    const app = getApp();
    const target = app.globalData.houses.find((h) => h.houseId === houseId);
    if (!target) return;
    app.globalData.currentHouse = target;
    this.setData({
      houses: this.data.houses.map((h) => ({ ...h, active: h.houseId === houseId })),
    });
    wx.showToast({ title: '已切换当前房屋', icon: 'success' });
  },

  onMenuTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === 'houses') wx.navigateTo({ url: '/pages/bind-house/bind-house' });
    if (key === 'payments') wx.navigateTo({ url: '/pages/payments/payments' });
    if (key === 'notify') wx.showToast({ title: '账单生成后将自动推送微信提醒', icon: 'none' });
    if (key === 'service') wx.showToast({ title: '请联系物业服务中心', icon: 'none' });
  },
});
