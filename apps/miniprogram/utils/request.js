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

function rawRequest(path, { method = 'GET', data = {} } = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.baseURL + path,
      method,
      data,
      header: {
        'Content-Type': 'application/json',
        Authorization: getToken() ? `Bearer ${getToken()}` : '',
      },
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
  const body = await rawRequest(path, options);
  if (body.code === 0) return body.data;

  if (body.code === 40100 && !retried) {
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
