/**
 * 微信开放接口的基础地址 —— 单一真源。
 *
 * 为什么不能用 HTTPS：微信云托管对 api.weixin.qq.com 做了代理劫持，且代理用的是
 * 自签证书。容器内发起 HTTPS 请求会在 TLS 握手阶段失败，Node 的 fetch 只抛出
 * 一句 `fetch failed`，cause.code 才是真正的原因 `DEPTH_ZERO_SELF_SIGNED_CERT`。
 *
 * 线上实测（GET /admin/operations/wx-probe）：
 *   https://api.weixin.qq.com/cgi-bin/token → fetch failed（DEPTH_ZERO_SELF_SIGNED_CERT），34ms
 *   http://api.weixin.qq.com/cgi-bin/token  → HTTP 200，微信真实响应
 *                                             errcode=41002 appid missing rid:6a689250-…
 * 那个 rid 证明请求确实穿过代理到达了微信服务，所以 HTTP 是通路、HTTPS 是死路。
 *
 * 影响面比订阅消息大得多：code2session（业主登录）、getuserphonenumber（手机号
 * 授权）、cgi-bin/token、tcb/*（云存储）全都在这个域名下，此前一律走 HTTPS，
 * 也就是说业主登录一直是坏的——之所以没被发现，是因为已登录用户的 JWT 未过期，
 * 老会话照样能用，只有新业主或令牌过期的人会卡在登录。
 *
 * 明文 HTTP 的安全性：这条链路是容器 → 云托管内部代理 → 微信，全程在腾讯内网，
 * 不出公网。这也是云托管官方给出的调用方式。
 *
 * 微信支付（api.mch.weixin.qq.com）不在劫持范围内，实测 HTTPS 正常（对账能真实
 * 下载账单，165–762ms），所以它保持 HTTPS，不要一起改掉。
 */

const DEFAULT_BASE = 'http://api.weixin.qq.com';

/**
 * 基础地址，可用 WX_API_BASE 覆盖。
 * 在云托管之外（本地直连、自有服务器）部署时可设为 https://api.weixin.qq.com。
 * 末尾斜杠会被去掉，避免拼出 `//cgi-bin`。
 */
export function wxApiBase(): string {
  return (process.env.WX_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
}

/** 拼接开放接口 URL；path 必须以 / 开头 */
export function wxApiUrl(path: string): string {
  return `${wxApiBase()}${path.startsWith('/') ? path : `/${path}`}`;
}
