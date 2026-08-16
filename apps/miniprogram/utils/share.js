/*
 * 转发/分享到朋友圈的统一配置。
 *
 * 微信的规则:页面**没定义** onShareAppMessage,右上角菜单里的「转发给朋友」
 * 就是灰的 —— 2026-08-15 实测:物业想把小程序转发给业主,发现转不了。
 * 朋友圈同理(onShareTimeline)。
 *
 * 落点统一是首页:被转发的人从头开始(绑定房屋 → 看账单),
 * 不落到转发者当时所在的页面 —— 那可能是他家的账单页。
 * 管理端(packageAdmin)刻意**不加**:管理页面的链接不该在业主群里流传。
 */
const SHARE = {
  title: '金港城物业缴费 —— 手机交物业费、查账单、报修',
  path: '/pages/index/index',
};

module.exports = {
  onShareAppMessage() {
    return { title: SHARE.title, path: SHARE.path };
  },
  onShareTimeline() {
    return { title: SHARE.title };
  },
};
