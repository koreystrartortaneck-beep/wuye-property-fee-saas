const config = require('../config');

/** 汇总订阅结果：是否至少接受一个、是否存在被拒绝的模板。 */
function summarizeSubscribeResult(tmplIds, res) {
  res = res || {};
  const accepted = tmplIds.some((id) => res[id] === 'accept');
  const denied = tmplIds.some((id) => res[id] === 'reject' || res[id] === 'ban');
  return { accepted, denied };
}

/**
 * 请求订阅消息授权（缴费提醒等）。必须在用户点击手势上下文中调用。
 * 未配置模板 ID 时静默跳过；用户拒绝不报错（降级：静默返回 false，不阻断主流程）。
 * 返回是否至少接受一个。
 */
function requestSubscribe() {
  const tmplIds = (config.subscribeTmplIds || []).filter(Boolean).slice(0, 3); // 微信一次最多 3 个
  if (tmplIds.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds,
      success: (res) => resolve(summarizeSubscribeResult(tmplIds, res).accepted),
      fail: () => resolve(false), // 拒绝/失败均降级，不抛错
    });
  });
}

module.exports = { requestSubscribe, summarizeSubscribeResult };
