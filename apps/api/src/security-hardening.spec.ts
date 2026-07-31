import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { GlobalExceptionFilter } from './common/http-exception.filter';
import { setupApp } from './setup-app';

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
   * token/私钥/JWT 形态），审计、告警、幂等记录都用了——唯独应用日志这条路径没用。
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

describe('安全响应头', () => {
  /*
   * 全库此前一个安全头都没有（无 helmet 依赖，nginx 的 admin location 也没有
   * add_header）。这里只验四条确定安全、不影响现有功能的。
   * Cache-Control: no-store 尤其要紧——API 响应里有手机号、房号、金额，
   * 浏览器或中间缓存留副本是实打实的泄露面。
   */
  function headersAfterSetup(): Record<string, string> {
    const out: Record<string, string> = {};
    let mw: ((req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => void) | null = null;
    const app = {
      use: (fn: typeof mw) => {
        mw = fn;
      },
      setGlobalPrefix: () => undefined,
      useGlobalPipes: () => undefined,
      useGlobalInterceptors: () => undefined,
      useGlobalFilters: () => undefined,
    };
    setupApp(app as never);
    expect(mw).not.toBeNull();
    mw!({}, { setHeader: (k: string, v: string) => (out[k] = v) }, () => undefined);
    return out;
  }

  const h = headersAfterSetup();

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
