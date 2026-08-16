const share = require('../../utils/share');
const { loadMyHouses } = require('../../utils/auth');

Page({
  // 转发/朋友圈:没有这两个回调,菜单里的分享是灰的(2026-08-15 实测)
  onShareAppMessage: share.onShareAppMessage,
  onShareTimeline: share.onShareTimeline,

  data: {
    nav: { spacerPx: 48, rowPx: 32 },
    // 物业服务
    propertyServices: [
      { key: 'repair', icon: '修', title: '报事报修', desc: '拍照一键上报', theme: 'amber' },
      { key: 'complaint', icon: '诉', title: '投诉建议', desc: '反馈与建议', theme: 'plum' },
    ],
    // 便民生活
    lifeServices: [
      { key: 'life', icon: '洁', title: '生活服务', desc: '保洁清洗上门', theme: 'emerald' },
      { key: 'visitor', icon: '客', title: '访客邀请', desc: '生成通行码', theme: 'sapphire' },
    ],
    hasPhone: false,
  },

  onLoad() {
    this.setData({ nav: getApp().globalData.nav });
  },

  async onShow() {
    await getApp().loginReady;
    await loadMyHouses().catch(() => []);
    const house = getApp().globalData.currentHouse;
    this.setData({ hasPhone: !!(house && house.servicePhone) });
  },

  tap(e) {
    const key = e.currentTarget.dataset.key;
    const routes = {
      repair: '/pages/ticket-create/ticket-create',
      complaint: '/pages/ticket-create/ticket-create?type=COMPLAINT',
      life: '/pages/services/services',
      visitor: '/pages/visitor/visitor',
    };
    if (routes[key]) wx.navigateTo({ url: routes[key] });
  },

  callManager() {
    const house = getApp().globalData.currentHouse;
    const phone = house && house.servicePhone;
    if (phone) wx.makePhoneCall({ phoneNumber: phone });
    else wx.showToast({ title: '物业暂未配置管家电话', icon: 'none' });
  },
});
