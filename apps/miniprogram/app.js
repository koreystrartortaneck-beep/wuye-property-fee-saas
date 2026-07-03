const { ensureLogin } = require('./utils/auth');

App({
  globalData: {
    user: null, // {id, hasPhone}
    houses: [], // GET /owner/my/houses
    currentHouse: null,
  },

  onLaunch() {
    this.loginReady = ensureLogin().catch((e) => {
      console.error('登录失败', e);
      return null;
    });
  },
});
