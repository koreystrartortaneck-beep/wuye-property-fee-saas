import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
    /*
     * 用 mock 时钟而不是真实等待。
     *
     * 原实现是「打两次 → setTimeout(60ms) → 再打一次」，窗口只有 30ms ——
     * 两次同步调用之间只要被调度出去超过 30ms，第二次就开了个新窗口、不再抛异常，
     * 断言随机失败。63 个套件并行时这完全可能，而且它**只是偶尔**红一次：
     * 不稳定的测试比失败的测试更糟，因为下一次绿灯会让人以为问题不存在。
     *
     * 我确实撞到过一次（611 里 1 条失败，随后 6 次全绿复现不了），
     * 顺着「依赖真实墙钟的断言」找过来的。
     */
    const guard = makeGuard({ limit: 1, windowMs: 30 });
    const t0 = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      expect(guard.canActivate(ctx('1.1.1.1'))).toBe(true);
      expect(() => guard.canActivate(ctx('1.1.1.1'))).toThrow();

      // 边界：正好到 resetAt 时仍算在窗口内（守卫的判定是 resetAt < now）
      clock.mockReturnValue(t0 + 30);
      expect(() => guard.canActivate(ctx('1.1.1.1'))).toThrow();

      // 过了边界才放行
      clock.mockReturnValue(t0 + 31);
      expect(guard.canActivate(ctx('1.1.1.1'))).toBe(true);
    } finally {
      clock.mockRestore();
    }
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

// ────────────────────────────────────────────────────────────────────────────
// 注释里宣称的保护必须真实存在
// ────────────────────────────────────────────────────────────────────────────

/**
 * 起因：guard 的文档注释列了 6 个「真正需要限流」的端点，其中
 * POST /payment/wxpay/notify **只写在注释里，从来没标 @RateLimit**。
 * 注释宣称的保护不存在比没有注释更糟 —— 它让人以为这里已经防住了，不会再去看。
 *
 * 所以把那份清单变成契约：列进注释的端点必须真的有标注。
 */
describe('限流清单与实际标注一致', () => {
  const apiSrc = join(__dirname, '..');

  /** 递归收集所有 .ts（排除 spec） */
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (e.name.endsWith('.ts') && !e.name.includes('.spec.')) out.push(p);
    }
    return out;
  }

  /**
   * 建立「完整路由 → 该处理器是否标了 @RateLimit」。
   *
   * 装饰器块的界定：从上一个成员结束（或类体开始）到本 HTTP 方法装饰器之间的文本。
   * 不能用「往上固定看 N 行」—— 那会把上一个方法的 @RateLimit 算到本方法头上，
   * 得到一份假的通过。这个坑本轮已经踩过（methodBody 的定长切片越界到下一个方法）。
   */
  function collectRoutes(): Map<string, boolean> {
    const routes = new Map<string, boolean>();
    for (const file of walk(apiSrc)) {
      const whole = readFileSync(file, 'utf8');
      /*
       * 必须按 @Controller 分段：upload.controller.ts 一个文件里有两个控制器
       * （owner/upload 与 admin/upload）。只取第一个 @Controller 会把 admin 的方法
       * 算成 owner 前缀 —— 于是 POST /admin/upload 被误报成「没标限流」，
       * 而它其实标了。这是我这条守卫的第一版真实犯下的错。
       */
      const ctrlRe = /@Controller\(\s*'([^']*)'\s*\)/g;
      const segs: Array<{ prefix: string; start: number; end: number }> = [];
      let c: RegExpExecArray | null;
      while ((c = ctrlRe.exec(whole))) {
        segs.push({ prefix: c[1], start: c.index, end: whole.length });
        if (segs.length > 1) segs[segs.length - 2].end = c.index;
      }
      if (!segs.length) continue;
      for (const seg of segs) {
      const src = whole.slice(seg.start, seg.end);
      const prefix = seg.prefix;
      const methodRe = /@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)/g;
      let m: RegExpExecArray | null;
      let blockStart = src.indexOf('{');
      while ((m = methodRe.exec(src))) {
        const block = src.slice(blockStart, m.index);
        const path = [prefix, m[2] ?? ''].filter(Boolean).join('/');
        const full = `${m[1].toUpperCase()} /${path}`;
        // 同一路由可能出现在多个控制器（owner/admin 各一份），任一处标了就算标了
        routes.set(full, (routes.get(full) ?? false) || /@RateLimit\(/.test(block));
        // 下一个装饰器块从本方法体结束处算起：找本方法的开括号再做括号匹配
        const bodyOpen = src.indexOf('{', methodRe.lastIndex);
        blockStart = bodyOpen < 0 ? methodRe.lastIndex : matchBrace(src, bodyOpen);
      }
      }
    }
    return routes;
  }

  /** 从 open 处的 { 起做括号匹配，返回配对 } 之后的位置 */
  function matchBrace(src: string, open: number): number {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return src.length;
  }

  /** 从 guard 的文档注释里解析出被宣称限流的端点 */
  function documentedRoutes(): string[] {
    const doc = readFileSync(join(__dirname, 'rate-limit.guard.ts'), 'utf8');
    const head = doc.slice(0, doc.indexOf('*/'));
    const out: string[] = [];
    for (const line of head.split('\n')) {
      const m = /^\s*\*\s+(GET|POST|PATCH|PUT|DELETE)\s+(\/\S+)/.exec(line);
      if (!m) continue;
      // 一行可能写多个：POST /auth/wx-login、/auth/phone
      for (const p of m[2].split(/[、,]/)) if (p.startsWith('/')) out.push(`${m[1]} ${p}`);
    }
    return out;
  }

  it('注释里能解析出端点清单（解析器自身别静默返回空）', () => {
    // 解析器写坏时会返回空数组，让下面那条断言变成永真 —— 先钉住它非空
    const docs = documentedRoutes();
    expect(docs.length).toBeGreaterThanOrEqual(7);
    expect(docs).toContain('POST /payment/wxpay/notify');
  });

  it('路由收集器自身能认出已知的标注与未标注端点', () => {
    // 同理：收集器写坏（比如全返回 true）会让主断言永真
    const routes = collectRoutes();
    expect(routes.get('POST /auth/wx-login')).toBe(true);
    // 业主查账单是纯读、没限流，用它验证收集器不是无脑返回 true
    expect(routes.get('GET /owner/bills')).toBe(false);
  });

  it('一个文件里的多个 @Controller 都要各按自己的前缀算', () => {
    // upload.controller.ts 有 owner/upload 与 admin/upload 两个控制器。
    // 只认第一个会让 admin/upload 凭空消失、并被误报成未限流。
    const routes = collectRoutes();
    expect(routes.get('POST /owner/upload')).toBe(true);
    expect(routes.get('POST /admin/upload')).toBe(true);
  });

  it('清单里的每个端点都真的标了 @RateLimit', () => {
    const routes = collectRoutes();
    const missing = documentedRoutes().filter((r) => routes.get(r) !== true);
    expect(missing).toEqual([]);
  });

  it('反向也要成立：标了限流的端点必须写进清单', () => {
    /*
     * 只做「清单 → 标注」这一个方向有个洞：从注释里删掉一行就能让契约缩小，
     * 测试照样全绿 —— 我把它注入验证时正是这么漏过去的。
     * 双向核对之后，删注释会因为「标了却没写进清单」失败，改不动。
     *
     * 顺带的好处：以后给某个端点加限流，必须同时把理由写进那份清单，
     * 阈值取值的依据不会散落在各个文件里。
     */
    const routes = collectRoutes();
    const documented = new Set(documentedRoutes());
    const undocumented = [...routes.entries()]
      .filter(([, limited]) => limited)
      .map(([r]) => r)
      .filter((r) => !documented.has(r))
      .sort();
    expect(undocumented).toEqual([]);
  });

  it('支付与退款回调的阈值必须足够宽——误伤等于钱不落账', () => {
    /*
     * 回调限流是有风险的防护：拒掉正常回调意味着支付不落账。
     * 阈值必须高到绝不可能碰上正常流量（微信来自少量固定 IP，1600 户集中缴费
     * 也远达不到单 IP 每秒 10 次），否则这条防护本身就是故障源。
     */
    for (const f of ['../payment/wxpay-notify.controller.ts', '../payment/wxpay-refund-notify.controller.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      const m = /@RateLimit\(\{\s*limit:\s*(\d+),\s*windowMs:\s*([\d_]+)/.exec(src);
      expect(m).not.toBeNull();
      const limit = Number(m![1]);
      const windowMs = Number(m![2].replace(/_/g, ''));
      expect(windowMs).toBe(60_000);
      expect(limit).toBeGreaterThanOrEqual(600);
    }
  });
});
