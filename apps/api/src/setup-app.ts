import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard } from './common/rate-limit.guard';
import { GlobalExceptionFilter } from './common/http-exception.filter';
import { ResponseInterceptor } from './common/response.interceptor';
import { TenantContextInterceptor } from './tenant/tenant-context.interceptor';
import { UploadPathsInterceptor } from './upload/sign-uploads.interceptor';

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

/** 生产与测试共用的应用装配（前缀/校验/响应协议/租户上下文/安全响应头） */
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
}
