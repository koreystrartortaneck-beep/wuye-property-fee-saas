import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard } from './common/rate-limit.guard';
import { GlobalExceptionFilter } from './common/http-exception.filter';
import { ResponseInterceptor } from './common/response.interceptor';
import { TenantContextInterceptor } from './tenant/tenant-context.interceptor';
import { UploadPathsInterceptor } from './upload/sign-uploads.interceptor';
import { verifyUploadToken } from './upload/upload-access';

/**
 * 安全响应头。
 *
 * 全库此前一个都没有（无 helmet 依赖、nginx 的 admin location 也没有 add_header）。
 * 这里只加确定安全、不会影响现有功能的四条：
 *   nosniff        —— 浏览器不得按内容猜 MIME；配合上传目录尤其重要
 *   X-Frame-Options —— 后台不允许被嵌进 iframe（点击劫持）
 *   Referrer-Policy —— 跳外链时不把带 ID 的后台 URL 带出去
 *   Cache-Control   —— API 响应一律不缓存：里面有手机号、房号、金额，
 *                      浏览器/中间缓存留副本是实打实的泄露面
 *
 * CORS 刻意不开：后台与 API 同源部署（前端用相对路径 /wuye/api/v1），
 * 不开 CORS 等于默认拒绝一切跨源浏览器调用，是 fail-closed 的正确配置。
 * CSP 需要按前端实际加载的资源来定，留给 nginx 侧统一加。
 */
function securityHeaders(app: INestApplication): void {
  const inner = app as unknown as {
    use(fn: (req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => void): void;
  };
  inner.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
}

/** 静态目录中间件用到的最小请求/响应形状 */
interface UploadReq {
  path: string;
  query?: { exp?: unknown; sig?: unknown };
}
interface UploadRes {
  status(code: number): { json(body: unknown): void };
}

/**
 * 上传目录的访问令牌校验。必须在 useStaticAssets 之前挂上。
 *
 * 这个目录原本**完全无鉴权**，而业主报修照片可能拍到户内、门牌、身份材料，
 * 只靠「时间戳 + 6 字节随机」的文件名保护 —— 48 位熵不可暴力枚举，但 URL 一旦经
 * referrer、截图、日志、转发外泄就长期有效且无法吊销。
 *
 * 用 query 里的签名而不是 Guard：图片走 <img src> 加载，浏览器不带 Authorization 头。
 *
 * 放在 setupApp 而不是 main.ts：**没有任何测试加载 main.ts**，放在那里等于这段
 * 安全控制零覆盖。挪过来之后测试应用与生产装配同一份代码，可以用真实 HTTP 请求验证。
 *
 * 生产配了 WX_CLOUD_ENV、图片走微信云存储的临时 URL，不经这条路径；
 * 这里保护的是自建部署（docker-compose.prod.yml 那套）的回退路径。
 */
function uploadTokenGuard(app: INestApplication): void {
  const inner = app as unknown as {
    use(path: string, fn: (req: UploadReq, res: UploadRes, next: () => void) => void): void;
  };
  inner.use('/uploads', (req, res, next) => {
    try {
      // req.path 在这个中间件里是去掉 /uploads 前缀后的部分，签名按完整路径算
      verifyUploadToken(`/uploads${req.path}`, req.query?.exp, req.query?.sig);
      next();
    } catch (e) {
      res.status(403).json({ code: 40300, message: e instanceof Error ? e.message : '禁止访问' });
    }
  });
}

/** 生产与测试共用的应用装配（前缀/校验/响应协议/租户上下文/安全响应头/上传令牌） */
export function setupApp(app: INestApplication): void {
  securityHeaders(app);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  /*
   * UploadPathsInterceptor 必须排在 ResponseInterceptor **之前**注册。
   * Nest 的全局拦截器按注册顺序进入、逆序出来，所以先注册的后处理响应体 ——
   * 排在前面才拿得到 ResponseInterceptor 包上 { code, data } 之后的整体，
   * 顺序写反则只签到未包装的内层，看起来也「有签名」，但 data 之外的字段漏掉。
   * 它对不含 /uploads/ 的响应零改动（原对象直接返回），所以全局注册没有副作用。
   */
  app.useGlobalInterceptors(
    new UploadPathsInterceptor(),
    new ResponseInterceptor(),
    new TenantContextInterceptor(),
  );
  /*
   * 速率限制守卫必须全局注册，否则各端点上的 @RateLimit 装饰器只是元数据、不生效。
   * 它对未标注的端点直接放行，所以全局注册没有副作用。
   * Reflector 从容器里取，避免自己 new 一个导致读不到 Nest 写入的元数据。
   */
  app.useGlobalGuards(new RateLimitGuard(app.get(Reflector)));
  app.useGlobalFilters(new GlobalExceptionFilter());
  /*
   * 放在最后注册没关系：Express 的中间件顺序按注册顺序，而 setGlobalPrefix
   * 不影响 app.use 挂的原始路径 —— /uploads 不带 /api/v1 前缀。
   * 关键约束是它必须早于 useStaticAssets（在 main.ts 里紧随 setupApp 调用）。
   */
  uploadTokenGuard(app);
}
