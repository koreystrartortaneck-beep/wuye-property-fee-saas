import { issueUploadToken, signUploadPaths, signUploadUrl, verifyUploadToken } from './upload-access';

/**
 * 本地上传目录的访问令牌。
 *
 * `app.useStaticAssets(UPLOAD_ROOT, { prefix: '/uploads/' })` 原本是**完全无鉴权**的。
 * 业主报修照片可能拍到户内、门牌、身份材料，而这些文件只靠「时间戳 + 6 字节随机」的
 * 文件名保护 —— 48 位熵不可暴力枚举，但 URL 一旦经 referrer、截图、日志、转发外泄
 * 就长期有效，且无法吊销。
 *
 * 用签名 query 而不是 Guard：图片走 <img src> 加载，浏览器不带 Authorization 头。
 *
 * 生产配了 WX_CLOUD_ENV、图片走微信云存储的临时 URL，**不经这条路径**；
 * 这里保护的是自建部署（docker-compose.prod.yml 那套）的回退路径 ——
 * 那也是唯一会把文件落到本机磁盘的模式。
 */
describe('上传访问令牌', () => {
  const P = '/uploads/202607/1780000000-abcdef.jpg';
  const OLD = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-xx';
  });
  afterAll(() => {
    if (OLD === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = OLD;
  });

  it('签发的令牌可通过校验', () => {
    const { exp, sig } = issueUploadToken(P);
    expect(() => verifyUploadToken(P, exp, sig)).not.toThrow();
  });

  it('signUploadUrl 产出可直接放进 <img src> 的地址', () => {
    const url = signUploadUrl(P);
    expect(url.startsWith(`${P}?exp=`)).toBe(true);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(() => verifyUploadToken(P, q.get('exp'), q.get('sig'))).not.toThrow();
  });

  it('换一个路径用同一个签名 → 拒绝（不能拿一张图的令牌看另一张）', () => {
    /*
     * 这是最关键的一条：若签名不绑路径，任何人拿到一个有效令牌就能遍历整个目录。
     */
    const { exp, sig } = issueUploadToken(P);
    expect(() => verifyUploadToken('/uploads/202607/other-file.jpg', exp, sig)).toThrow();
  });

  it('改过期时间 → 拒绝（不能自己把有效期延长）', () => {
    const { exp, sig } = issueUploadToken(P);
    expect(() => verifyUploadToken(P, exp + 86_400_000, sig)).toThrow();
  });

  it('过期即拒绝，且提示让用户知道该刷新页面', () => {
    const now = Date.now();
    const { exp, sig } = issueUploadToken(P, now);
    expect(() => verifyUploadToken(P, exp, sig, exp + 1)).toThrow(/过期/);
  });

  it('有效期不超过 15 分钟（够一次浏览与刷新，不够被转发出去长期使用）', () => {
    const now = 1_780_000_000_000;
    const { exp } = issueUploadToken(P, now);
    expect(exp - now).toBeGreaterThan(60_000);
    expect(exp - now).toBeLessThanOrEqual(15 * 60_000);
  });

  it('缺令牌 / 空签名 / 非数字过期时间 一律拒绝', () => {
    expect(() => verifyUploadToken(P, undefined, undefined)).toThrow();
    expect(() => verifyUploadToken(P, Date.now() + 1000, '')).toThrow();
    expect(() => verifyUploadToken(P, 'not-a-number', 'x')).toThrow();
  });

  it('伪造签名被拒，且长度不同也不会抛 TypeError', () => {
    /*
     * timingSafeEqual 要求两个 Buffer 等长，否则直接抛 TypeError ——
     * 那会变成 500 而不是 403，还会暴露「长度不对」这个信息。所以先比长度。
     */
    const { exp } = issueUploadToken(P);
    for (const bad of ['x', 'a'.repeat(43), 'a'.repeat(200)]) {
      let err: unknown;
      try {
        verifyUploadToken(P, exp, bad);
      } catch (e) {
        err = e;
      }
      expect((err as { code?: number }).code).toBe(40300);
    }
  });

  it('换密钥后旧令牌失效（密钥轮换能吊销全部已发出的 URL）', () => {
    const { exp, sig } = issueUploadToken(P);
    process.env.JWT_SECRET = 'another-secret-at-least-32-chars-long';
    try {
      expect(() => verifyUploadToken(P, exp, sig)).toThrow();
    } finally {
      process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-xx';
    }
  });

  it('没有 JWT_SECRET 时拒绝签发，而不是用空密钥签出人人可伪造的令牌', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      expect(() => issueUploadToken(P)).toThrow(/JWT_SECRET/);
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });
});

describe('签名必须真的接到链路上', () => {
  /*
   * 这一组也要设 JWT_SECRET：上一个 describe 的 beforeAll 只作用于它自己，
   * 而本组里有真调 signUploadPaths 的用例。
   */
  const SAVED = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-xx';
  });
  afterAll(() => {
    if (SAVED === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = SAVED;
  });

  /*
   * 光有签名工具不够：上传返回的地址若不带签名、或静态目录前不做校验，
   * 整套机制就等于没接。注入「上传不再返回签名 URL」时，前面 10 条用例全绿——
   * 这个缺口是注入验证发现的。
   */
  function code(rel: string): string {
    return require('node:fs')
      .readFileSync(require('node:path').join(__dirname, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('上传返回裸路径给入库、另给一个带签名的预览地址', () => {
    /*
     * 这个区分是必须的，而且方向容易搞反：
     * 前端会把 url 存进 Ticket.images / WorkLog.images，而签名只有 10 分钟有效 ——
     * 若 url 带签名，10 分钟后所有历史图片全部打不开。
     * 所以 url 必须是裸路径，签名要在**读取时**现签；viewUrl 只供上传后立刻预览。
     * 本守卫第一版断言的正是反过来的形状（url 必须带签名），会把正确实现判成错误。
     */
    const src = code('upload.controller.ts');
    expect(src).toMatch(/url: pathname/);
    expect(src).toMatch(/viewUrl: signUploadUrl\(pathname\)/);
  });

  it('返回图片的读取点都在读取时现签', () => {
    const READERS = [
      '../tickets/tickets.service.ts',
      '../work-logs/admin-work-logs.controller.ts',
      '../work-logs/owner-work-logs.controller.ts',
    ];
    const missing: string[] = [];
    for (const rel of READERS) {
      if (!code(rel).includes('signUploadPaths(')) missing.push(rel);
    }
    if (missing.length) {
      throw new Error(
        '以下返回图片的接口没有在读取时现签，自建部署下图片会 403：\n  ' + missing.join('\n  '),
      );
    }
    expect(missing).toEqual([]);
  });

  it('signUploadPaths 只改写 /uploads 路径，cloud:// 与外链原样返回', () => {
    const out = signUploadPaths(['/uploads/202607/a.jpg', 'cloud://x/y.jpg', 'https://e.com/z.png', '']);
    expect(out[0].startsWith('/uploads/202607/a.jpg?exp=')).toBe(true);
    expect(out[1]).toBe('cloud://x/y.jpg');
    expect(out[2]).toBe('https://e.com/z.png');
    // 空串被过滤掉，不产出坏地址
    expect(out).toHaveLength(3);
  });

  it('images 不是数组时返回空数组，不抛异常', () => {
    // Json 列可能存进 null 或对象（历史数据/手工改库）
    expect(signUploadPaths(null)).toEqual([]);
    expect(signUploadPaths({ a: 1 })).toEqual([]);
  });

  it('静态目录挂载之前有校验中间件', () => {
    const src = code('../main.ts');
    const verifyAt = src.indexOf('verifyUploadToken(');
    const staticAt = src.indexOf('useStaticAssets(');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(staticAt).toBeGreaterThan(-1);
    // 顺序反了的话静态文件会先被 express 直接吐出去
    expect(verifyAt).toBeLessThan(staticAt);
  });

  it('校验失败返回 403 而不是放行', () => {
    const src = code('../main.ts');
    expect(src).toMatch(/res\.status\(403\)/);
    // catch 里不得调 next()
    const block = src.slice(src.indexOf("app.use('/uploads'"), src.indexOf('useStaticAssets('));
    const catchBody = /catch \([\s\S]{0,200}?\}/.exec(block)?.[0] ?? '';
    expect(catchBody).not.toContain('next()');
  });
});
