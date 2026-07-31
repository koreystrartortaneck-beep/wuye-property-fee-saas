import { createHmac, timingSafeEqual } from 'node:crypto';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';

/**
 * 本地上传目录的访问令牌。
 *
 * 为什么需要它：`app.useStaticAssets(UPLOAD_ROOT, { prefix: '/uploads/' })` 是**完全
 * 无鉴权**的。业主报修照片可能拍到户内、门牌、身份材料，而这些文件只靠
 * 「时间戳 + 6 字节随机」的文件名保护 —— 48 位熵不可暴力枚举，但 URL 一旦经 referrer、
 * 截图、日志、转发外泄就长期有效，且无法吊销。
 *
 * 为什么用签名 URL 而不是直接鉴权：图片是通过 `<img src>` 加载的，浏览器不会带
 * Authorization 头，所以「加个 Guard」这条路走不通。把签名放进 query 是同类问题的
 * 标准解法（微信云存储的临时 URL 也是这个形状）。
 *
 * 生产现状：配了 WX_CLOUD_ENV，图片走微信云存储的 cloud:// + 临时 URL，本身有鉴权，
 * **不经过这条路径**。所以这里保护的是自建部署（deploy/docker-compose.prod.yml
 * 那套）的回退路径 —— 那也是唯一会把文件落到本机磁盘的模式。
 *
 * 签名内容刻意只包含路径与过期时间，不含用户 ID：
 * 一张工单照片会被多个管理员看到，绑用户会让每人各拿一份 URL、缓存全部失效；
 * 而短有效期（默认 10 分钟）已经把「URL 长期有效」这个核心问题解决了。
 */

/** 令牌有效期。够一次页面浏览与刷新，不够被转发出去长期使用。 */
const TTL_MS = 10 * 60_000;

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) {
    // 与其它 fail-closed 的地方一致：宁可起不来，也不要用一个空密钥签出人人可伪造的令牌
    throw new Error('缺少 JWT_SECRET，无法签发上传访问令牌');
  }
  return s;
}

function sign(pathname: string, expMs: number): string {
  return createHmac('sha256', secret()).update(`${pathname}|${expMs}`).digest('base64url');
}

/** 为某个 /uploads/... 路径签发访问令牌 */
export function issueUploadToken(pathname: string, now = Date.now()): { exp: number; sig: string } {
  const exp = now + TTL_MS;
  return { exp, sig: sign(pathname, exp) };
}

/** 把令牌拼到路径上，得到可直接放进 <img src> 的地址 */
export function signUploadUrl(pathname: string, now = Date.now()): string {
  const { exp, sig } = issueUploadToken(pathname, now);
  return `${pathname}?exp=${exp}&sig=${sig}`;
}

/**
 * 校验访问令牌。
 * 用 timingSafeEqual 而不是 `===`：签名比较的时序差异可以被用来逐字节猜签名。
 */
export function verifyUploadToken(
  pathname: string,
  exp: unknown,
  sig: unknown,
  now = Date.now(),
): void {
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || typeof sig !== 'string' || !sig) {
    throw new BizException(ErrorCode.FORBIDDEN, '图片访问令牌缺失');
  }
  if (expMs < now) {
    throw new BizException(ErrorCode.FORBIDDEN, '图片访问令牌已过期，请刷新页面');
  }
  const expected = Buffer.from(sign(pathname, expMs));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new BizException(ErrorCode.FORBIDDEN, '图片访问令牌无效');
  }
}

/**
 * 给一批图片地址现签。
 *
 * 存库的必须是裸路径（`/uploads/...`），签名在**每次读取时**现加 —— 存带签名的地址
 * 会让 10 分钟后所有历史图片全部打不开。
 *
 * 非 /uploads 开头的原样返回：cloud:// 走微信云存储的临时 URL、http(s):// 是外链，
 * 两者都不该被这里改写。
 */
export function signUploadPaths(images: unknown, now = Date.now()): string[] {
  if (!Array.isArray(images)) return [];
  return images
    .filter((x): x is string => typeof x === 'string' && !!x)
    .map((x) => signIfUploadPath(x, now));
}

/**
 * 单个字符串：是本地上传路径就现签，否则原样返回。
 *
 * 幂等——已带签名的原样返回。签两次会得到 `...?exp=1&sig=a?exp=2&sig=b`，
 * 校验时 exp 解析为 NaN，图片必然 403；而全局拦截器与残留的逐处调用会叠加，
 * 所以幂等不是锦上添花，是正确性前提。
 */
export function signIfUploadPath(value: string, now = Date.now()): string {
  if (!value.startsWith('/uploads/')) return value;
  if (value.includes('sig=')) return value;
  return signUploadUrl(value, now);
}

/**
 * 去掉图片地址上的访问令牌，取回可入库的裸路径。
 *
 * 为什么需要：响应出口统一现签之后，客户端手里的地址是带签名的。
 * 若某个编辑流程把读到的地址原样提交回来（前端很自然会这么做），
 * 入库的就成了带签名的路径 —— 10 分钟后这条记录的图永久打不开，且无法从库里看出原因。
 * 所有接收图片的写入口都必须先过这里，把入口收窄成「库里只存裸路径」。
 */
export function stripUploadSignature(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  return images
    .filter((x): x is string => typeof x === 'string' && !!x)
    .map((x) => (x.startsWith('/uploads/') ? x.replace(/\?.*$/, '') : x));
}
