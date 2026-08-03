const config = require('../config');

const TOKEN_KEY = 'pf_token';

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || '';
}

function setToken(token) {
  wx.setStorageSync(TOKEN_KEY, token);
}

function clearToken() {
  wx.removeStorageSync(TOKEN_KEY);
}

/*
 * 请求超时。
 *
 * 原来两个分支都没设 timeout，wx.request/callContainer 的默认是 60 秒 ——
 * 缴费确认要连查 5 次，一旦挂住就是数分钟的「确认支付结果」干转，
 * 业主只能看着转圈，不知道钱到底扣没扣。真实事故里就是这个表现。
 *
 * 12 秒：够慢网下一次正常往返（生产实测在 1 秒内），又不会让人盯着转圈。
 */
const TIMEOUT_MS = 12000;

function rawRequest(path, { method = 'GET', data = {}, token } = {}) {
  // token 覆盖:管理端分包用管理员令牌调管理接口,业主令牌照旧走存储
  const bearer = token || getToken();
  const auth = bearer ? `Bearer ${bearer}` : '';

  // 云托管：走 wx.cloud.callContainer 免备案内部通道
  if (config.useCloud) {
    return new Promise((resolve, reject) => {
      wx.cloud.callContainer({
        config: { env: config.cloudEnv },
        path: config.apiPrefix + path, // /api/v1 + /owner/xxx
        method,
        header: {
          'X-WX-SERVICE': config.cloudService, // 路由到对应云托管服务，必填
          'content-type': 'application/json',
          Authorization: auth,
        },
        data,
        timeout: TIMEOUT_MS,
        success: (res) => resolve(res.data),
        fail: (err) => reject(new Error(err.errMsg || '云调用失败')),
      });
    });
  }

  // 自有服务器直连（回滚保底）
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.baseURL + path,
      method,
      data,
      header: {
        'Content-Type': 'application/json',
        Authorization: auth,
      },
      timeout: TIMEOUT_MS,
      success: (res) => resolve(res.data),
      fail: (err) => reject(new Error(err.errMsg || '网络异常')),
    });
  });
}

/**
 * 统一请求：code!==0 报错 toast 并 reject；
 * 40100 时清 token → 重登一次 → 重放请求。
 */
async function request(path, options = {}, retried = false) {
  let body;
  try {
    body = await rawRequest(path, options);
  } catch (e) {
    // 网络层失败必须可见，且显示原始原因便于定位（域名校验/无网络/服务器不可达）
    const reason = (e && e.message) || '未知原因';
    wx.showToast({ title: `网络失败: ${reason}`.slice(0, 60), icon: 'none', duration: 4000 });
    throw e;
  }
  if (body.code === 0) return body.data;

  if (body.code === 40100 && !retried && path !== '/auth/wx-login' && !options.token) {
    // 管理员令牌过期不走业主重登(那只会拿到业主身份)——交给调用方重新换发
    clearToken();
    const { ensureLogin } = require('./auth');
    await ensureLogin();
    return request(path, options, true);
  }

  if (!options.silent) {
    wx.showToast({ title: body.message || '请求失败', icon: 'none' });
  }
  const err = new Error(body.message || '请求失败');
  err.code = body.code;
  throw err;
}

module.exports = { request, getToken, setToken, clearToken };
