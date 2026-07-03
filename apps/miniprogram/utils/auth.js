const config = require('../config');
const { request, getToken, setToken } = require('./request');

const MOCK_OPENID_KEY = 'pf_mock_openid';

/** dev 模式的稳定 mock openid（首次生成后持久化） */
function mockOpenid() {
  let id = wx.getStorageSync(MOCK_OPENID_KEY);
  if (!id) {
    id = 'dev-' + Math.random().toString(36).slice(2, 10);
    wx.setStorageSync(MOCK_OPENID_KEY, id);
  }
  return id;
}

function wxLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => resolve(res.code),
      fail: () => reject(new Error('微信登录失败')),
    });
  });
}

/** 确保已登录：返回 {id, hasPhone} */
async function ensureLogin() {
  const app = getApp();
  if (getToken() && app && app.globalData.user) return app.globalData.user;

  const code = config.mockAuth ? `mock:${mockOpenid()}` : await wxLoginCode();
  const data = await request('/auth/wx-login', { method: 'POST', data: { code } });
  setToken(data.token);
  if (app) app.globalData.user = data.user;
  return data.user;
}

/** 手机号授权（mock：明文手机号；real：getphonenumber 事件 code） */
async function bindPhone(phoneOrCode) {
  const code = config.mockAuth ? `phone:${phoneOrCode}` : phoneOrCode;
  const data = await request('/auth/phone', { method: 'POST', data: { code } });
  const app = getApp();
  if (app && app.globalData.user) app.globalData.user.hasPhone = true;
  return data; // {phone, matchedHouses}
}

/** 拉取我的房屋并缓存到 globalData，返回列表 */
async function loadMyHouses() {
  const houses = await request('/owner/my/houses');
  const app = getApp();
  if (app) {
    app.globalData.houses = houses;
    if (!app.globalData.currentHouse && houses.length > 0) {
      app.globalData.currentHouse = houses[0];
    }
    // 当前房屋已解绑时回退
    if (app.globalData.currentHouse && !houses.find((h) => h.houseId === app.globalData.currentHouse.houseId)) {
      app.globalData.currentHouse = houses[0] || null;
    }
  }
  return houses;
}

module.exports = { ensureLogin, bindPhone, loadMyHouses };
