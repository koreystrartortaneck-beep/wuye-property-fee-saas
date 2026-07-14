const config = require('./config');
const { ensureLogin } = require('./utils/auth');

App({
  globalData: {
    user: null, // {id, hasPhone}
    houses: [], // GET /owner/my/houses
    currentHouse: null,
    nav: { spacerPx: 48, rowPx: 32 }, // 自定义导航度量（onLaunch 时按系统胶囊实测）
  },

  onLaunch() {
    // 云托管初始化：callContainer 免备案内部通道（env 指向云托管环境）
    if (wx.cloud && config.cloudEnv) {
      wx.cloud.init({ env: config.cloudEnv, traceUser: true });
    }

    // 自定义导航页的标题行必须与系统胶囊按钮精确同行，否则会互相遮挡
    try {
      const menu = wx.getMenuButtonBoundingClientRect();
      this.globalData.nav = { spacerPx: menu.top, rowPx: menu.height };
    } catch (e) {
      const info = wx.getWindowInfo();
      const sb = (info && info.statusBarHeight) || 44;
      this.globalData.nav = { spacerPx: sb + 4, rowPx: 32 };
    }

    this.loginReady = ensureLogin().catch((e) => {
      console.error('登录失败', e);
      return null;
    });
  },
});
