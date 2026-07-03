/**
 * 环境配置。
 * mockAuth=true：微信登录用 mock:<持久化随机串>，手机号授权用输入框（后端 WX_MODE=mock）。
 *
 * 体验版/真机说明：8443 为 HTTP 明文 + IP 直连，需在小程序里打开
 * 「右上角 … → 开发调试」后重启，方可跳过合法域名/HTTPS 校验。
 * 正式版上线前需换成备案 https 域名并置 mockAuth=false。
 */
module.exports = {
  // 生产（体验版）：东北服务器公网入口
  baseURL: 'http://58.244.176.174:8443/wuye/api/v1',
  // 本地开发时换回：
  // baseURL: 'http://127.0.0.1:3000/api/v1',
  mockAuth: true,
};
