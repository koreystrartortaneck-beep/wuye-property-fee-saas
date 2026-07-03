import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('管理端登录与守卫', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await prisma.raw.adminUser.deleteMany({ where: { username: { in: ['adm-t7', 'staff-t7'] } } });
    await prisma.raw.tenant.deleteMany({ where: { code: 'adm-t7' } });
    const tenant = await prisma.raw.tenant.create({ data: { name: '守卫测试物业', code: 'adm-t7' } });
    tenantId = tenant.id;
    const hash = await bcrypt.hash('pass123', 10);
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'adm-t7', passwordHash: hash, name: '管理员', role: 'TENANT_ADMIN' },
    });
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'staff-t7', passwordHash: hash, name: '员工', role: 'STAFF' },
    });
  });

  afterAll(async () => {
    await prisma.raw.adminUser.deleteMany({ where: { tenantId } });
    await prisma.raw.tenant.delete({ where: { id: tenantId } });
    await app.close();
  });

  it('正确账密登录成功，profile 可访问', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'adm-t7', password: 'pass123' })
      .expect(200);
    expect(login.body.code).toBe(0);
    expect(login.body.data.profile.role).toBe('TENANT_ADMIN');

    const profile = await request(app.getHttpServer())
      .get('/api/v1/admin/auth/profile')
      .set('Authorization', `Bearer ${login.body.data.token}`)
      .expect(200);
    expect(profile.body.data.tenantId).toBe(tenantId);
  });

  it('错误密码 40100', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'adm-t7', password: 'wrong' })
      .expect(200);
    expect(res.body.code).toBe(40100);
  });

  it('owner token 不能访问 admin 接口', async () => {
    const wx = await request(app.getHttpServer())
      .post('/api/v1/auth/wx-login')
      .send({ code: 'mock:guard-cross-openid' });
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/auth/profile')
      .set('Authorization', `Bearer ${wx.body.data.token}`)
      .expect(200);
    expect(res.body.code).toBe(40100);
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'guard-cross-openid' } });
  });
});
