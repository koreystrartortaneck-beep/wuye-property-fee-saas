import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('业主认证：微信登录 + 手机号自动绑定', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);

    // 预置：租户 + 小区 + 一套登记了业主手机号的房
    await prisma.raw.houseBinding.deleteMany({ where: { wxUser: { openid: 'auth-test-openid' } } });
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'auth-test-openid' } });
    const oldTenant = await prisma.raw.tenant.findUnique({ where: { code: 'auth-t' } });
    if (oldTenant) {
      await prisma.raw.house.deleteMany({ where: { tenantId: oldTenant.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: oldTenant.id } });
      await prisma.raw.tenant.delete({ where: { id: oldTenant.id } });
    }
    const tenant = await prisma.raw.tenant.create({ data: { name: '认证测试物业', code: 'auth-t' } });
    tenantId = tenant.id;
    const community = await prisma.raw.community.create({
      data: { tenantId, name: '认证测试小区' },
    });
    await prisma.raw.house.create({
      data: {
        tenantId,
        communityId: community.id,
        code: '1-1-101',
        displayName: '1 栋 1 单元 101',
        area: 100,
        ownerName: '测试业主',
        ownerPhone: '13900001111',
      },
    });
  });

  afterAll(async () => {
    await prisma.raw.houseBinding.deleteMany({ where: { tenantId } });
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'auth-test-openid' } });
    await prisma.raw.house.deleteMany({ where: { tenantId } });
    await prisma.raw.community.deleteMany({ where: { tenantId } });
    await prisma.raw.tenant.delete({ where: { id: tenantId } });
    await app.close();
  });

  let token: string;

  it('wx-login：mock code 建号并返回 token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/wx-login')
      .send({ code: 'mock:auth-test-openid' })
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.user.hasPhone).toBe(false);
    token = res.body.data.token;
  });

  it('未带 token 调 /auth/phone 返回 40100', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/phone')
      .send({ code: 'phone:13900001111' })
      .expect(200);
    expect(res.body.code).toBe(40100);
  });

  it('手机号授权后自动匹配绑定房屋', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/phone')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'phone:13900001111' })
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.phone).toBe('13900001111');
    expect(res.body.data.matchedHouses).toBe(1);

    const binding = await prisma.raw.houseBinding.findFirst({
      where: { wxUser: { openid: 'auth-test-openid' } },
    });
    expect(binding?.status).toBe('ACTIVE');
    expect(binding?.source).toBe('PHONE_MATCH');
    expect(binding?.tenantId).toBe(tenantId);
  });

  it('重复授权幂等（不重复建绑定）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/phone')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'phone:13900001111' })
      .expect(200);
    expect(res.body.code).toBe(0);
    const count = await prisma.raw.houseBinding.count({
      where: { wxUser: { openid: 'auth-test-openid' } },
    });
    expect(count).toBe(1);
  });

  it('非 mock 前缀 code 在 mock 模式被拒', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/wx-login')
      .send({ code: 'real-code-xyz' })
      .expect(200);
    expect(res.body.code).toBe(40000);
  });
});
