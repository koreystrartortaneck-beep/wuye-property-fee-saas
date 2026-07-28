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
  cloudEnv: 'wuye-api-d2gql1e3g718d01c9', // 云托管环境ID（wx.cloud.init + callContainer 均用它）
  cloudService: 'wuye-api', // 云托管服务名（callContainer 需带 X-WX-SERVICE 头）
  apiPrefix: '/api/v1', // NestJS 全局前缀

  // ===== 自有服务器直连（回滚保底；useCloud=false 时生效）=====
  baseURL: 'http://58.244.176.174:8443/wuye/api/v1',
  // 本地开发：baseURL: 'http://127.0.0.1:3000/api/v1', useCloud: false

  mockAuth: false,

  /*
   * 订阅消息模板 ID。
   *
   * 公众平台「功能 → 订阅消息」选用的是同一个公共模板（33214 缴费业务通知 /
   * 物业管理），出账、到期、逾期三类通知共用它，靠「温馨提示」字段区分文案，
   * 所以这里只有一个 ID，后端三个环境变量
   * （WX_TMPL_BILL_CREATED / WX_TMPL_DUE_SOON / WX_TMPL_OVERDUE）也都填这一个。
   *
   * 这里必须填：不填业主端根本不会弹订阅授权，弹不出授权就永远收不到通知
   * ——后端配好模板 ID 也没用。
   *
   * 注意这是一次性订阅：用户每授权一次只能下发一条，所以小程序在缴费等
   * 关键节点会再次请求授权来累积额度。
   */
  subscribeTmplIds: [
    'jvaB_jR2VUolwxPk1MRV1by9d3Kg2AXyn21JdiIhFOk', // 缴费业务通知（出账/到期/逾期共用）
  ],
};
