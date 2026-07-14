/**
 * 环境配置。
 * mockAuth=true：微信登录用 mock:<持久化随机串>，手机号授权用输入框（后端 WX_MODE=mock）。
 *
 * 当前生产走【微信云托管】—— wx.cloud.callContainer 免备案内部通道，无需合法域名/HTTPS 校验。
 * 回滚到自有服务器直连时，把 useCloud 置 false（直连需在小程序「… → 开发调试」跳过域名校验）。
 * 正式版上线前置 mockAuth=false（接真实微信登录/支付）。
 */
module.exports = {
  // ===== 云托管（免备案，当前生产）=====
  useCloud: true,
  cloudEnv: 'wuye-api-d5g9kagygdd670922', // 云托管环境ID（wx.cloud.init + callContainer 均用它）
  cloudService: 'wuye-api', // 云托管服务名（callContainer 需带 X-WX-SERVICE 头）
  apiPrefix: '/api/v1', // NestJS 全局前缀

  // ===== 自有服务器直连（回滚保底；useCloud=false 时生效）=====
  baseURL: 'http://58.244.176.174:8443/wuye/api/v1',
  // 本地开发：baseURL: 'http://127.0.0.1:3000/api/v1', useCloud: false

  mockAuth: true,
};
