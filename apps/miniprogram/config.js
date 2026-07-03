/**
 * 环境配置。
 * mockAuth=true：微信登录用 mock:<持久化随机串>，手机号授权用输入框（后端 WX_MODE=mock）。
 * 上线时改 baseURL 为 https 域名并置 mockAuth=false。
 */
module.exports = {
  baseURL: 'http://127.0.0.1:3000/api/v1',
  mockAuth: true,
};
