const { request } = require('./request');

/*
 * 管理端(分包)的登录与请求。
 *
 * 认证方式:微信授权手机号匹配 AdminUser.phone → 服务端换发管理员令牌
 * (POST /auth/admin-exchange)。物业人员不用电脑,也不用记任何密码 ——
 * 和业主一样授权一次手机号,是管理员就多出「物业管理」入口。
 *
 * 令牌只放内存,不落存储:
 *   · 有效期 12 小时,而换发是静默的、随时可再换 —— 缓存收益趋近于零
 *   · 落了存储,借手机给别人用小程序时管理令牌还躺在里面
 */

let session = null; // { token, name, role, at }

/** 静默探测:是管理员返回 {name, role},不是返回 null。每次进入管理端都重新换发。 */
async function exchangeAdmin() {
  try {
    const res = await request('/auth/admin-exchange', { method: 'POST', silent: true });
    if (res && res.admin) {
      session = { ...res.admin, at: Date.now() };
      return { name: session.name, role: session.role };
    }
  } catch (e) {
    // 探测失败(网络/未授权手机号)一律按「不是管理员」处理,入口不亮
  }
  session = null;
  return null;
}

/** 距上次换发超过 10 小时就重新换(令牌 12h,留 2h 余量,避免用到一半失效) */
async function ensureAdmin() {
  if (session && Date.now() - session.at < 10 * 3600 * 1000) return session;
  const ok = await exchangeAdmin();
  if (!ok) {
    const err = new Error('没有管理权限');
    err.code = 40300;
    throw err;
  }
  return session;
}

/** 管理端请求:自动带管理员令牌;令牌失效自动重换发一次再重放 */
async function adminRequest(path, options = {}) {
  const s = await ensureAdmin();
  try {
    return await request(path, { ...options, token: s.token });
  } catch (e) {
    if (e && e.code === 40100) {
      session = null;
      const s2 = await ensureAdmin();
      return request(path, { ...options, token: s2.token });
    }
    throw e;
  }
}

function currentAdmin() {
  return session ? { name: session.name, role: session.role } : null;
}

module.exports = { exchangeAdmin, ensureAdmin, adminRequest, currentAdmin };
