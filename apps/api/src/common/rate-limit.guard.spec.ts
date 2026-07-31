import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_KEY, RateLimitGuard, type RateLimitOptions } from './rate-limit.guard';

/**
 * 端点级速率限制。
 *
 * 此前只有管理端登录做了限流，其余一律没有。真正需要的几处：
 *   /auth/wx-login、/auth/phone   每次都向微信外呼，可被用来刷爆 AppSecret 侧的接口
 *                                 配额（配额按小程序算，刷爆后所有业主都登录不了）
 *   /owner/upload、/admin/upload  每次最多 5MB 落盘，而上传目录与 MySQL 共享宿主磁盘
 *   /admin/arrears/dun            改成落 Outbox 后单次很快，反而更容易被连点，
 *                                 重复排通知会耗掉业主的订阅额度
 *   /admin/cloud-files/urls       每次向微信换一批 2 小时有效的下载链接
 */
describe('RateLimitGuard', () => {
  function makeGuard(options?: RateLimitOptions) {
    const reflector = {
      get: (key: string) => (key === RATE_LIMIT_KEY ? options : undefined),
    } as unknown as Reflector;
    return new RateLimitGuard(reflector);
  }

  function ctx(ip: string | undefined, route = '/auth/wx-login') {
    return {
      getHandler: () => () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ ip, route: { path: route } }) }),
    } as never;
  }

  it('未标注 @RateLimit 的端点不受影响', () => {
    const guard = makeGuard(undefined);
    for (let i = 0; i < 100; i += 1) expect(guard.canActivate(ctx('1.1.1.1'))).toBe(true);
  });

  it('窗口内超过阈值即拒绝，并给出可读提示', () => {
    const guard = makeGuard({ limit: 3, windowMs: 60_000, message: '登录请求过于频繁，请稍后再试' });
    for (let i = 0; i < 3; i += 1) expect(guard.canActivate(ctx('1.1.1.1'))).toBe(true);
    expect(() => guard.canActivate(ctx('1.1.1.1'))).toThrow('登录请求过于频繁');
  });

  it('不同 IP 各自计数（不能一个人把所有人打瘫）', () => {
    /*
     * 这正是登录限流踩过的坑：没开 trust proxy 时 req.ip 是网关地址，
     * 所有来源共用一个桶 —— 限流不但无效，还变成任何人每分钟发几十个请求
     * 就能把全部管理员锁在门外的 DoS。
     */
    const guard = makeGuard({ limit: 2, windowMs: 60_000 });
    expect(guard.canActivate(ctx('1.1.1.1'))).toBe(true);
    expect(guard.canActivate(ctx('1.1.1.1'))).toBe(true);
    expect(() => guard.canActivate(ctx('1.1.1.1'))).toThrow();
    // 另一个 IP 不受影响
    expect(guard.canActivate(ctx('2.2.2.2'))).toBe(true);
  });

  it('不同端点各自计数（上传占额度不该影响登录）', () => {
    const guard = makeGuard({ limit: 1, windowMs: 60_000 });
    expect(guard.canActivate(ctx('1.1.1.1', '/owner/upload'))).toBe(true);
    expect(() => guard.canActivate(ctx('1.1.1.1', '/owner/upload'))).toThrow();
    expect(guard.canActivate(ctx('1.1.1.1', '/auth/wx-login'))).toBe(true);
  });

  it('窗口过期后重新放行', () => {
    const guard = makeGuard({ limit: 1, windowMs: 30 });
    expect(guard.canActivate(ctx('1.1.1.1'))).toBe(true);
    expect(() => guard.canActivate(ctx('1.1.1.1'))).toThrow();
    // 用真实等待而不是改系统时间：守卫内部用 Date.now()，窗口只有 30ms
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(guard.canActivate(ctx('1.1.1.1'))).toBe(true);
        resolve();
      }, 60);
    });
  });

  it('拿不到 IP 时放行，而不是一律拒绝', () => {
    /*
     * 取不到来源就拦，会在反向代理配置变动时把**全部**正常请求挡掉——
     * 那是比「漏掉限流」严重得多的故障。限流是尽力而为，宁可放过。
     */
    const guard = makeGuard({ limit: 1, windowMs: 60_000 });
    for (let i = 0; i < 10; i += 1) expect(guard.canActivate(ctx(undefined))).toBe(true);
  });

  it('拒绝时用 40000（参数/业务错误），不会被前端当成登录失效', () => {
    /*
     * 若用 401，小程序的 request.js 会以为令牌过期、自动重登再重试——
     * 那等于把「太频繁」变成了「更频繁」。
     */
    const guard = makeGuard({ limit: 0, windowMs: 60_000 });
    try {
      guard.canActivate(ctx('1.1.1.1'));
      throw new Error('应当抛出');
    } catch (e) {
      expect((e as { code?: number }).code).toBe(40000);
    }
  });

  it('计数表不会无限增长', () => {
    // 灌入远超上界的不同 IP，条目数必须被压回可控范围
    const guard = makeGuard({ limit: 100, windowMs: 60_000 });
    for (let i = 0; i < 25_000; i += 1) guard.canActivate(ctx(`10.0.${(i >> 8) & 255}.${i & 255}`));
    const size = (guard as unknown as { hits: Map<string, unknown> }).hits.size;
    expect(size).toBeLessThanOrEqual(20_001);
  });
});
