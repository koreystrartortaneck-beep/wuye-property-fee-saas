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

/*
 * ── 为什么会有下面这套节流，而不是「在业主本来就要点的地方多调几次」 ──
 *
 * 原来这里有个 accrueSubscribeQuota()，理由是：业主若勾过「总是保持以上选择，
 * 不再询问」，后续调用就静默通过，于是可以在他自然点击的节点无感累积额度。
 * 我据此把它挂到了「点账单卡片」「首页主按钮」「返回首页」上。
 *
 * 这个赌注下错了：**大多数业主并没有勾过那个选项**。于是点每一张账单都弹一次
 * 授权框——账单卡片是整个小程序里最高频的点击。反复弹、反复被关掉，只会把人
 * 训练成条件反射点「取消」，最后落到 reject/ban，比从不打扰更糟。
 * 而额度本身是投机性的：真正要发的提醒（出账、到期、逾期）一个月才几条。
 *
 * 现在的规则：
 *   · 只在**与提醒本身相关**的时刻问 —— 缴费时（提醒讲的就是账单），
 *     以及「我的 → 开启缴费提醒」（业主自己要的）。纯跳转一概不问。
 *   · 同一台设备 7 天内最多问一次，除非上次已是 accept（那种调用对业主无感）。
 *   · 被微信禁用（ban）之后不再问 —— 弹也弹不出来。
 */
const ASK_GAP_MS = 7 * 24 * 60 * 60 * 1000;
const STORE_KEY = 'subscribeAsk';

function readAskRecord() {
  try {
    const v = wx.getStorageSync(STORE_KEY);
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
}

function writeAskRecord(rec) {
  try {
    wx.setStorageSync(STORE_KEY, rec);
  } catch (e) {
    // 存不下就退化成「每次都按首次处理」，不影响主流程
  }
}

/** 把 requestSubscribeMessage 的逐模板结果收敛成一个状态 */
function stateOf(tmplIds, res) {
  res = res || {};
  if (tmplIds.some((id) => res[id] === 'ban')) return 'ban';
  if (tmplIds.some((id) => res[id] === 'accept')) return 'accept';
  return 'reject';
}

/**
 * 在合适的时机请求订阅授权；不合适就什么也不做。
 *
 * 用在业主本来就要做的动作上（目前只有缴费）。不 await 也不提示，
 * 拒绝与失败都静默降级——它永远不该妨碍业主原本要做的事。
 *
 * 注意：wx.requestSubscribeMessage 必须在点击手势的上下文里同步发起，
 * 所以这里的判据只读 **同步** 的本地存储，不去调 wx.getSetting
 * （那是异步的，await 一次就丢了手势上下文，弹窗根本弹不出来）。
 */
function maybeRequestSubscribe() {
  const tmplIds = (config.subscribeTmplIds || []).filter(Boolean).slice(0, 3);
  if (tmplIds.length === 0) return Promise.resolve(false);

  const rec = readAskRecord();
  if (rec.state === 'ban') return Promise.resolve(false);
  // accept 的调用对业主是无感的（他勾过「不再询问」），可以照常累积额度
  if (rec.state !== 'accept' && rec.askedAt && Date.now() - rec.askedAt < ASK_GAP_MS) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds,
      success: (res) => {
        writeAskRecord({ askedAt: Date.now(), state: stateOf(tmplIds, res) });
        resolve(summarizeSubscribeResult(tmplIds, res).accepted);
      },
      fail: () => {
        // 失败也记一次，避免出问题时反复弹
        writeAskRecord({ askedAt: Date.now(), state: rec.state || 'reject' });
        resolve(false);
      },
    });
  });
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
  maybeRequestSubscribe,
  getSubscribeState,
  summarizeSubscribeResult,
};
