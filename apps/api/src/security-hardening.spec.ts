import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { GlobalExceptionFilter } from './common/http-exception.filter';
import { setupApp } from './setup-app';
import { RateLimitGuard } from './common/rate-limit.guard';

/**
 * 几条安全加固，都不是漏洞级但都有确定的现实后果。
 *
 * 已核实过、不在本文件范围内的：微信支付回调验签完整、金额双向校验、重放去重、
 * 租户隔离 fail-closed、Mock 实现必须显式声明否则启动失败、审计脱敏引擎双向生效、
 * 审计表 DB 层 append-only 触发器、CORS 刻意不开（同源部署，fail-closed）。
 */

describe('异常日志必须脱敏', () => {
  /*
   * 全库有一套很扎实的脱敏器（audit.service 的 redactString，覆盖 openid/手机号/
   * token/私钥/JWT 形态），审计、告警、幂等记录都用了，而应用日志这条路径**原先漏了**（已接上，本处即是）。
   * 而落到兜底分支的典型异常是 PrismaClientValidationError /
   * PrismaClientUnknownRequestError，Prisma 会把**完整调用参数**拼进 message：
   * wxUser.upsert 的 openid、adminUser.create 的 passwordHash、房屋的 ownerPhone
   * 都会原样进容器日志，被运维、日志采集侧、云控制台看到。
   */
  function capture(error: unknown): string {
    const logged: string[] = [];
    const filter = new GlobalExceptionFilter();
    // Nest 的 Logger 实例挂在 filter 上，替换掉它的 error 方法即可捕获
    (filter as unknown as { logger: { error(v: unknown): void } }).logger = {
      error: (v: unknown) => logged.push(String(v)),
    };
    const res = { status: () => res, json: () => res };
    const host = {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ url: '/x', method: 'POST' }) }),
    };
    filter.catch(error, host as never);
    return logged.join('\n');
  }

  it('手机号被打码', () => {
    const out = capture(new Error('house.update failed for ownerPhone 13800138000'));
    expect(out).not.toContain('13800138000');
  });

  it('openid 被打码', () => {
    const out = capture(new Error('wxUser.upsert openid: oABCDEFGHIJKLMNOPQRSTUVWXYZ12'));
    expect(out).not.toContain('oABCDEFGHIJKLMNOPQRSTUVWXYZ12');
  });

  it('Bearer 令牌被打码', () => {
    const out = capture(new Error('authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'));
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig');
  });

  it('超长 message 被截断（Prisma 校验错误能有上万字符，完整打印会把有用的头部冲掉）', () => {
    const out = capture(new Error('X'.repeat(50_000)));
    expect(out.length).toBeLessThan(6_000);
  });

  it('仍然记录了有用信息，不是整条丢掉', () => {
    const out = capture(new Error('house.update failed for ownerPhone 13800138000'));
    expect(out).toContain('house.update');
  });

  it('已识别的 Prisma 错误不落到兜底日志（它们被翻成可操作提示）', () => {
    const out = capture(
      new Prisma.PrismaClientKnownRequestError('boom', { code: 'P2002', clientVersion: 't', meta: { target: ['code'] } }),
    );
    expect(out).toBe('');
  });
});

type Mw = (req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => void;

describe('安全响应头', () => {
  /*
   * 全库此前一个安全头都没有（无 helmet 依赖，nginx 的 admin location 也没有
   * add_header）。这里只验四条确定安全、不影响现有功能的。
   * Cache-Control: no-store 尤其要紧——API 响应里有手机号、房号、金额，
   * 浏览器或中间缓存留副本是实打实的泄露面。
   */
  /*
   * 返回响应头与被注册的守卫。
   *
   * 断言必须放在 it() 里，不能放在这个 helper 里 —— 它在 describe 体内被调用，
   * helper 里的 expect 失败会让整个 suite「跑不起来」（Tests: 0），
   * 注入错误时看不出是哪条断言挂了，只能看到 suite crash。第一版就是这样。
   */
  function setupAndCapture(): { headers: Record<string, string>; guards: unknown[] } {
    const out: Record<string, string> = {};
    let mw: ((req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => void) | null = null;
    const guards: unknown[] = [];
    const app = {
      use: (fn: typeof mw) => {
        mw = fn;
      },
      setGlobalPrefix: () => undefined,
      useGlobalPipes: () => undefined,
      useGlobalInterceptors: () => undefined,
      useGlobalFilters: () => undefined,
      // setupApp 现在还要从容器里取 Reflector 来装配速率限制守卫
      useGlobalGuards: (...g: unknown[]) => guards.push(...g),
      get: () => ({ get: () => undefined }),
    };
    setupApp(app as never);
    // 显式取出再调：TS 会把「只在回调里赋值」的 mw 窄化成 never
    const middleware = mw as Mw | null;
    if (middleware) middleware({}, { setHeader: (k: string, v: string) => (out[k] = v) }, () => undefined);
    return { headers: out, guards };
  }

  const captured = setupAndCapture();
  const h = captured.headers;

  it('速率限制守卫已全局注册（不注册的话各端点的 @RateLimit 只是元数据、不生效）', () => {
    expect(captured.guards.some((g) => g instanceof RateLimitGuard)).toBe(true);
  });

  it('安全头中间件已装上', () => {
    expect(Object.keys(h).length).toBeGreaterThan(0);
  });

  it('nosniff：浏览器不得按内容猜 MIME（配合上传目录尤其重要）', () => {
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });

  it('后台不允许被嵌进 iframe', () => {
    expect(h['X-Frame-Options']).toBe('DENY');
  });

  it('跳外链时不把带 ID 的后台 URL 带出去', () => {
    expect(h['Referrer-Policy']).toBe('same-origin');
  });

  it('API 响应一律不缓存（含手机号/房号/金额）', () => {
    expect(h['Cache-Control']).toBe('no-store');
  });
});

describe('上传必须按真实字节校验，而不是信客户端声明', () => {
  /*
   * fileFilter 判的是 multipart 头里客户端自己声明的 Content-Type，扩展名又是从这个
   * 声明映射来的——磁盘上可以躺着任意内容的 .jpg。当前靠「扩展名决定响应
   * Content-Type」阻断了 XSS 执行，但配合无鉴权的 /uploads 静态目录，这实际上是一个
   * 免费的匿名文件寄存服务（可被用来托管违法内容，而责任归属在部署方）。
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const uploadModule = require('./upload/upload.controller') as {
    uploadOptions: { fileFilter: (r: unknown, f: { mimetype: string }, cb: (e: unknown, ok: boolean) => void) => void };
  };

  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-spec-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 直接调 toResult 走不通（它拼 URL 依赖模块内私有函数），改为调 assertRealImage */
  function assertReal(bytes: Buffer): { ok: boolean; exists: boolean } {
    const p = path.join(dir, 'x.jpg');
    fs.writeFileSync(p, bytes);
    const mod = require('./upload/upload.controller') as {
      __test_assertRealImage?: (f: { path: string }) => void;
    };
    const fn = mod.__test_assertRealImage;
    if (!fn) throw new Error('upload.controller 未导出 __test_assertRealImage，无法做行为断言');
    try {
      fn({ path: p });
      return { ok: true, exists: fs.existsSync(p) };
    } catch {
      return { ok: false, exists: fs.existsSync(p) };
    }
  }

  it('真 JPEG 通过', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
    expect(assertReal(jpeg).ok).toBe(true);
  });

  it('真 PNG 通过', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8)]);
    expect(assertReal(png).ok).toBe(true);
  });

  it('真 WebP 通过', () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
    expect(assertReal(webp).ok).toBe(true);
  });

  it('伪装成 jpg 的可执行/脚本内容被拒，且文件被删掉', () => {
    const fake = Buffer.from('<?php system($_GET["c"]); ?>                ');
    const r = assertReal(fake);
    expect(r.ok).toBe(false);
    expect(r.exists).toBe(false); // 不能把不合规的文件留在磁盘上
  });

  it('空文件被拒', () => {
    expect(assertReal(Buffer.alloc(0)).ok).toBe(false);
  });

  it('声明的 MIME 白名单仍然生效（第一道闸门没被移除）', () => {
    let rejected = false;
    uploadModule.uploadOptions.fileFilter({}, { mimetype: 'application/pdf' }, (e) => {
      rejected = !!e;
    });
    expect(rejected).toBe(true);
  });
});

/**
 * 会外呼第三方、占磁盘、或给一批业主发通知的端点必须限流。
 *
 * 此前只有管理端登录做了限流，其余一律没有。这几处各有确定的后果：
 *   /auth/wx-login、/auth/phone   每次都向微信外呼；配额按小程序算，刷爆之后
 *                                 **所有业主都登录不了**
 *   /owner/upload、/admin/upload  每次最多 5MB 落盘，而上传目录与 MySQL 共享宿主磁盘，
 *                                 磁盘打满两个一起挂
 *   /admin/arrears/dun            改成落 Outbox 后单次很快，反而更容易被连点，
 *                                 重复排通知会耗掉业主的一次性订阅额度
 *   /admin/cloud-files/urls       每次向微信换一批 2 小时有效的下载链接
 */
describe('高风险端点必须限流', () => {
  const CASES: Array<{ file: string; marker?: string; controller?: string; what: string }> = [
    { file: 'auth/auth.controller.ts', marker: "@Post('wx-login')", what: '业主登录（外呼微信）' },
    { file: 'auth/auth.controller.ts', marker: "@Post('phone')", what: '手机号授权（外呼微信）' },
    /*
     * 上传的两个端点都是 @Post()（无路径），无法用它定位。
     * 改用「从该 @Controller 到下一个 @Controller 之间必须出现 @RateLimit」——
     * 两个上传控制器各自独立，任一漏标都会被抓到。
     */
    { file: 'upload/upload.controller.ts', controller: "@Controller('owner/upload')", what: '业主上传（占磁盘）' },
    { file: 'upload/upload.controller.ts', controller: "@Controller('admin/upload')", what: '管理端上传（占磁盘）' },
    { file: 'billing/arrears.controller.ts', marker: "@Post('dun')", what: '批量催缴（耗业主订阅额度）' },
    { file: 'admin/cloud-files.controller.ts', marker: "@Post('urls')", what: '云文件解析（外呼微信）' },
  ];

  function src(rel: string): string {
    return fs
      .readFileSync(path.join(__dirname, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('每个高风险端点都标了 @RateLimit', () => {
    const offenders: string[] = [];
    for (const c of CASES) {
      const code = src(c.file);

      // 控制器级：从该 @Controller 到下一个 @Controller 之间必须出现 @RateLimit
      if (c.controller) {
        const start = code.indexOf(c.controller);
        if (start === -1) {
          offenders.push(`${c.file} 找不到 ${c.controller}（${c.what}）——被改名了？请同步更新本测试`);
          continue;
        }
        const nextAt = code.indexOf('@Controller(', start + c.controller.length);
        const block = code.slice(start, nextAt === -1 ? undefined : nextAt);
        if (!block.includes('@RateLimit(')) {
          offenders.push(`${c.what}：${c.controller} 这个控制器里没有 @RateLimit`);
        }
        continue;
      }

      const at = code.indexOf(c.marker as string);
      if (at === -1) {
        offenders.push(`${c.file} 找不到 ${c.marker}（${c.what}）——被改名了？请同步更新本测试`);
        continue;
      }
      /*
       * @RateLimit 必须紧挨在该端点之前的装饰器块内。
       * 只在整个文件里 grep 会误判：同一文件的另一个端点标了就算过
       * （upload.controller 有两个 @Post()，这正是会踩的形状）。
       */
      const before = code.slice(Math.max(0, at - 400), at);
      if (!before.includes('@RateLimit(')) {
        offenders.push(`${c.what}：${c.marker} 之前没有 @RateLimit`);
      }
    }
    if (offenders.length) throw new Error('高风险端点缺少限流：\n  ' + offenders.join('\n  '));
    expect(offenders).toEqual([]);
  });

  it('限流阈值都是正数（写 0 会把端点彻底关掉）', () => {
    const files = ['auth/auth.controller.ts', 'upload/upload.controller.ts', 'billing/arrears.controller.ts', 'admin/cloud-files.controller.ts'];
    const bad: string[] = [];
    for (const f of files) {
      for (const m of src(f).matchAll(/@RateLimit\(\{\s*limit:\s*(\d+)/g)) {
        if (Number(m[1]) <= 0) bad.push(`${f} → limit: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('cloud-files 有角色限制与数量上限', () => {
    /*
     * 这个端点把任意 cloud:// fileID 换成可访问的临时 URL，且不校验文件是否属于本租户。
     * 原先只有 AdminGuard（无 @Roles，等于任何已登录管理员）、fileIds 只有 @IsArray()
     * 而没有数量上限。
     */
    const code = src('admin/cloud-files.controller.ts');
    expect(code).toMatch(/@Roles\(/);
    expect(code).toMatch(/@ArrayMaxSize\(\d+/);
  });
});
