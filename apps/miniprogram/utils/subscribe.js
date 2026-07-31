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
 *
 * 关于额度：物业管理类目拿不到微信的「长期订阅」（只对政务民生/医疗/交通/金融/
 * 教育等线下公共服务开放），只能用一次性订阅——**业主授权一次只能收到一条**。
 * 但授权弹窗里有「总是保持以上选择，不再询问」，业主勾选并允许之后，后续调用会
 * 自动通过且不再弹窗，于是可以在业主自然点击的节点无感累积额度。
 * 这就是为什么要在多个节点调用它，而不是只在一处。
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

/**
 * 顺带累积额度：用于「业主本来就要点的按钮」上，不打断主流程。
 *
 * 与 requestSubscribe 的区别只在意图——这里明确不关心结果、不给任何提示。
 * 若业主此前勾过「不再询问」，这一步是完全无感的；若没勾过，最多多看一次弹窗，
 * 点「取消」也不影响他原本要做的事。
 */
function accrueSubscribeQuota() {
  return requestSubscribe().catch(() => false);
}

/**
 * 读取当前订阅授权状态，用于在界面上如实显示，而不是每次都让业主盲点一遍。
 * 返回 'accept' | 'reject' | 'ban' | 'unknown'：
 *   accept  —— 已勾选「不再询问」且允许，后续调用会静默通过
 *   reject  —— 明确拒绝过（仍可再次弹窗询问）
 *   ban     —— 被微信禁用（需去右上角设置里开）
 *   unknown —— 从未表态，或读取失败
 */
function getSubscribeState() {
  const tmplIds = (config.subscribeTmplIds || []).filter(Boolean);
  if (tmplIds.length === 0) return Promise.resolve('unknown');
  return new Promise((resolve) => {
    wx.getSetting({
      withSubscriptions: true,
      success: (res) => {
        const setting = res.subscriptionsSetting || {};
        // 总开关关掉时，任何模板都发不出去
        if (setting.mainSwitch === false) return resolve('ban');
        const item = (setting.itemSettings || {})[tmplIds[0]];
        resolve(item || 'unknown');
      },
      fail: () => resolve('unknown'),
    });
  });
}

module.exports = {
  requestSubscribe,
  accrueSubscribeQuota,
  getSubscribeState,
  summarizeSubscribeResult,
};
