const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * 链路验证云函数：小程序 wx.cloud.callFunction('hello') 调用它。
 * 调用成功即证明「小程序 → 云函数」免备案通道打通（openid 由微信自动注入）。
 */
exports.main = async () => {
  const { OPENID, APPID } = cloud.getWXContext();
  return {
    ok: true,
    message: '云函数链路已打通（免备案）',
    openid: OPENID,
    appid: APPID,
    time: new Date().toISOString(),
  };
};
