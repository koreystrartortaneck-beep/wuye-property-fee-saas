const config = require('../config');

/**
 * 请求订阅消息授权（缴费提醒等）。必须在用户点击手势上下文中调用。
 * 未配置模板 ID 时静默跳过；用户拒绝不报错。返回是否至少接受一个。
 */
function requestSubscribe() {
  const tmplIds = (config.subscribeTmplIds || []).filter(Boolean).slice(0, 3); // 微信一次最多 3 个
  if (tmplIds.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds,
      success: (res) => resolve(tmplIds.some((id) => res[id] === 'accept')),
      fail: () => resolve(false),
    });
  });
}

module.exports = { requestSubscribe };
