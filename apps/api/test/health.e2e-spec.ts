import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app';

describe('健康检查与统一响应协议', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health 返回统一包装', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    /*
     * health 除了 status 还返回 startedAt / uptimeSec / serverTime ——
     * 用来判断「新版本上没上」：推 GitHub 后云托管自动构建 6~10 分钟且没有回执，
     * 而部署必然重启进程、uptime 归零。
     * 所以这里不能再用 toEqual 锁死整个 data（那会把这三个字段判成多余）。
     */
    expect(res.body.code).toBe(0);
    expect(res.body.message).toBe('ok');
    expect(res.body.data.status).toBe('up');
    expect(typeof res.body.data.uptimeSec).toBe('number');
    expect(Object.keys(res.body.data).sort()).toEqual([
      'serverTime',
      'startedAt',
      'status',
      'uptimeSec',
    ]);
  });

  it('不存在的路由返回业务码 40400', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(200);
    expect(res.body.code).toBe(40400);
  });
});
