import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('业主图片上传', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/wx-login')
      .send({ code: 'mock:upl-test' });
    token = login.body.data.token;
  });

  afterAll(async () => {
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'upl-test' } });
    await app.close();
  });

  it('上传 png 成功并返回 /uploads/ 路径', async () => {
    // 1x1 px PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', png, { filename: 'a.png', contentType: 'image/png' })
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.url).toMatch(/^\/uploads\/\d{6}\/.+\.png$/);
  });

  it('非图片类型被拒 44003', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' })
      .expect(200);
    expect(res.body.code).toBe(44003);
  });

  it('未登录被拒 40100', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/upload')
      .attach('file', Buffer.from('x'), { filename: 'a.png', contentType: 'image/png' })
      .expect(200);
    expect(res.body.code).toBe(40100);
  });
});
