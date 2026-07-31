import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@pf/shared';
import { BizException } from './biz.exception';

/**
 * 端点级速率限制。
 *
 * 此前只有管理端登录做了限流（admin-auth.controller 里的 ipHits），其余一律没有。
 * 真正需要的几处：
 *
 *   POST /auth/wx-login、/auth/phone   每次调用都会**向微信外呼**，可被用来刷爆
 *                                      AppSecret 侧的接口配额（配额是按小程序算的，
 *                                      刷爆之后所有业主都登录不了）
 *   POST /owner/upload、/admin/upload  每次最多 5MB 落盘，而上传目录与 MySQL 共享宿主
 *                                      磁盘，磁盘打满两个一起挂
 *   POST /admin/arrears/dun            批量催缴，有幂等键但没有频率上限
 *   POST /admin/cloud-files/urls       每次向微信换一批 2 小时有效的下载链接
 *   POST /payment/wxpay/notify         验签在限流之后，可被用来消耗 RSA 验签的 CPU
 *   POST /payment/wxpay/refund-notify  同上
 *   POST /owner/coupons/:id/claim      每次写库并生成核销码；脚本连打会白占库存名额、
 *                                      刷掉别人能领的份额（超发本身由唯一约束挡住）
 *
 * 上面这份清单不是说明文字，是被测试核对的契约（rate-limit.guard.spec.ts）：
 * 列进来却没标 @RateLimit 会让测试失败。加这条守卫是因为清单里的
 * /payment/wxpay/notify 原本就**只写在注释里、没有真标注** —— 注释宣称的保护不存在，
 * 比没有注释更糟：它让人以为这里已经防住了。
 *
 * 实现刻意保持与登录限流一致的形态：**单实例内存计数**。
 * 现在是 min=1 常驻单实例，够用；水平扩展时必须换共享存储（Redis），
 * 否则 N 个实例各自计数，实际阈值变成 N 倍。这一点写在这里而不是留给以后猜。
 *
 * 计数键是「路由 + 客户端 IP」。IP 取自 req.ip，依赖 main.ts 里的
 * `app.set('trust proxy', 1)` —— 不开的话 req.ip 是网关地址，所有人共用一个桶，
 * 限流不但无效还会变成 DoS（这个坑登录限流已经踩过一次）。
 */

export interface RateLimitOptions {
  /** 时间窗内允许的最大请求数 */
  limit: number;
  /** 时间窗长度（毫秒） */
  windowMs: number;
  /** 超限时给用户看的提示。默认文案对业主也说得通 */
  message?: string;
}

export const RATE_LIMIT_KEY = 'pf:rate-limit';

/** 标在方法上即生效；未标注的端点不受限流影响 */
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);

/** 计数表条目上界，超过即淘汰过期项（防内存无限增长） */
const TABLE_MAX = 20_000;

@Injectable()
export class RateLimitGuard implements CanActivate {
  /** key -> { count, resetAt } */
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.get<RateLimitOptions | undefined>(RATE_LIMIT_KEY, context.getHandler());
    if (!options) return true;

    const req = context.switchToHttp().getRequest<{ ip?: string; route?: { path?: string }; url?: string }>();
    const route = req.route?.path ?? req.url ?? 'unknown';
    // 拿不到 IP 时不拦：宁可放过也不要因为取不到来源而误伤正常请求
    const ip = req.ip;
    if (!ip) return true;

    const now = Date.now();
    this.evictIfNeeded(now);

    const key = `${route}|${ip}`;
    const entry = this.hits.get(key);
    /*
     * 新窗口的第一次请求也要过阈值判断。
     * 原实现直接 return true，于是 limit: 0 时第一次请求会被放行 —— 阈值写 0 本意是
     * 「完全禁用」，却漏了一次。虽然当前没有端点用 0，但这种「第一次不检查」的形状
     * 在阈值调小时会悄悄少算一次配额。
     */
    if (!entry || entry.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + options.windowMs });
      if (1 > options.limit) {
        throw new BizException(ErrorCode.VALIDATION, options.message ?? '操作过于频繁，请稍后再试');
      }
      return true;
    }
    entry.count += 1;
    if (entry.count > options.limit) {
      throw new BizException(
        ErrorCode.VALIDATION,
        options.message ?? '操作过于频繁，请稍后再试',
      );
    }
    return true;
  }

  private evictIfNeeded(now: number): void {
    if (this.hits.size <= TABLE_MAX) return;
    for (const [k, v] of this.hits) if (v.resetAt < now) this.hits.delete(k);
    // 清完仍超上界说明短时间内涌入了大量不同来源：整表重建。
    // 限流本身是尽力而为，宁可放过一轮也不要无限增长。
    if (this.hits.size > TABLE_MAX) this.hits.clear();
  }
}
