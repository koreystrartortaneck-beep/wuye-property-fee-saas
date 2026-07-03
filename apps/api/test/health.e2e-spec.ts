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
    expect(res.body).toEqual({ code: 0, message: 'ok', data: { status: 'up' } });
  });

  it('不存在的路由返回业务码 40400', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(200);
    expect(res.body.code).toBe(40400);
  });
});
