const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');

const RELATION_LABEL = { OWNER: '业主', FAMILY: '家属', TENANT: '租客' };

Page({
  data: {
    nav: { spacerPx: 48, rowPx: 32 },
    userName: '业主',
    phone: '',
    avatarText: '宅',
    currentHouse: null, // {communityName, displayName, tag}
    houseCount: 0,
    pendingBindings: [],
    menus: [
      { key: 'tickets', title: '我的工单', desc: '报修与投诉建议进度' },
      { key: 'orders', title: '我的预约', desc: '生活服务预约记录' },
      { key: 'payments', title: '缴费记录', desc: '查看历史付款凭证' },
    ],
  },

  onLoad() {
    this.setData({ nav: getApp().globalData.nav });
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
        houseCount: houses.length,
        currentHouse: current
          ? {
              communityName: current.communityName,
              displayName: current.displayName,
              tag: RELATION_LABEL[current.relation] || current.relation,
            }
          : null,
      });
    } catch (e) {
      console.error(e);
    }
  },

  /** 点当前房屋卡：弹出切换菜单（末项为绑定新房屋） */
  switchHouse() {
    const app = getApp();
    const houses = app.globalData.houses || [];
    const items = houses.map((h) => `${h.communityName} ${h.displayName}`);
    items.push('＋ 绑定新房屋');
    wx.showActionSheet({
      itemList: items.slice(0, 6), // 微信上限 6 项
      success: (res) => {
        if (res.tapIndex === items.length - 1) {
          this.goBind();
          return;
        }
        const target = houses[res.tapIndex];
        if (!target) return;
        app.globalData.currentHouse = target;
        this.setData({
          currentHouse: {
            communityName: target.communityName,
            displayName: target.displayName,
            tag: RELATION_LABEL[target.relation] || target.relation,
          },
        });
        wx.showToast({ title: '已切换当前房屋', icon: 'success' });
      },
    });
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind-house/bind-house' });
  },

  onMenuTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === 'tickets') wx.navigateTo({ url: '/pages/tickets/tickets' });
    if (key === 'orders') wx.navigateTo({ url: '/pages/services/services?tab=1' });
    if (key === 'payments') wx.navigateTo({ url: '/pages/payments/payments' });
  },
});
