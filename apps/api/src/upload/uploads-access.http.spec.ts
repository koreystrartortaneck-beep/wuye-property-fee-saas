import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { setupApp } from '../setup-app';
import { signUploadUrl } from './upload-access';

/**
 * HTTP 级回归：`/uploads` 的访问令牌校验真的拦得住。
 *
 * 起因：这段校验原本写在 main.ts 里，而**没有任何测试会加载 main.ts** ——
 * 一段安全控制长期零覆盖。upload-access.spec.ts 测的是签名函数本身，
 * 而「中间件有没有挂上」「挂的位置对不对」「过期/篡改时返回什么」全都没测到。
 *
 * 生产走微信云存储（cloud://），这条路径在线上无法端到端验证：
 * 我实测过，穿过 nginx 打 /wuye/uploads/ 只能确认返回 403「令牌缺失」，
 * 拿不到一个真实的带签名地址来验证放行分支。所以放行分支只能靠这里的测试保证。
 *
 * 用真实 Nest app + setupApp：与生产装配同一份代码，
 * 单测式的直接调函数无法覆盖「中间件是否注册」这件事。
 */

/** 占位控制器：Nest 应用至少要有一个模块 */
@Controller('probe')
class ProbeController {
  @Get()
  ok() {
    return { ok: true };
  }
}

describe('/uploads 访问令牌的 HTTP 行为', () => {
  let app: INestApplication;
  const OLD_SECRET = process.env.JWT_SECRET;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-secret-for-uploads-http';
    const mod = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (OLD_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = OLD_SECRET;
  });

  it('无令牌 → 403，且不泄露文件是否存在', async () => {
    const res = await request(app.getHttpServer()).get('/uploads/2026/07/x.jpg');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40300);
    // 403 必须先于「文件找不到」返回：否则 404/403 的差异就是一个存在性探测口
    expect(res.body.message).toContain('令牌');
  });

  it('签名被篡改 → 403', async () => {
    const signed = signUploadUrl('/uploads/2026/07/x.jpg');
    const tampered = `${signed.slice(0, -1)}${signed.slice(-1) === 'A' ? 'B' : 'A'}`;
    const res = await request(app.getHttpServer()).get(tampered);
    expect(res.status).toBe(403);
  });

  it('已过期 → 403，且提示可操作', async () => {
    // 用 11 分钟前签的（TTL 10 分钟）
    const expired = signUploadUrl('/uploads/2026/07/x.jpg', Date.now() - 11 * 60_000);
    const res = await request(app.getHttpServer()).get(expired);
    expect(res.status).toBe(403);
    // 过期是正常现象（页面停留久了），提示必须告诉用户刷新，而不是只说「无效」
    expect(res.body.message).toContain('刷新');
  });

  it('换一个路径复用签名 → 403（签名绑定路径）', async () => {
    const signed = signUploadUrl('/uploads/2026/07/x.jpg');
    const qs = signed.slice(signed.indexOf('?'));
    const res = await request(app.getHttpServer()).get(`/uploads/2026/07/别人的.jpg${qs}`);
    expect(res.status).toBe(403);
  });

  it('签名正确 → 放行到静态目录（不再是 403）', async () => {
    /*
     * 这条覆盖的是放行分支 —— 也就是生产上无法验证的那一半。
     * 文件不存在所以最终是 404，但 404 本身就是证据：请求已经过了中间件。
     * 若中间件把正确签名也拦掉（比如路径拼接写错），这里会是 403。
     */
    const signed = signUploadUrl('/uploads/2026/07/x.jpg');
    const res = await request(app.getHttpServer()).get(signed);
    expect(res.status).not.toBe(403);
  });

  it('普通接口不受这个中间件影响', async () => {
    // 中间件挂在 /uploads 上，若误挂到根路径，全站都会 403
    const res = await request(app.getHttpServer()).get('/api/v1/probe');
    expect(res.status).toBe(200);
  });
});
