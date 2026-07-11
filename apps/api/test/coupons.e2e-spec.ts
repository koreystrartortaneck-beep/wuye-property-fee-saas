import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('卡券：物业发券 → 领取 → 核销', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let communityId: string;
  let houseId: string;
  let ownerToken: string;
  let adminToken: string;
  let couponId: string;
  let claimCode: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'cpn-p4' } });
    if (t) {
      await prisma.raw.userCoupon.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.coupon.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.houseBinding.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.adminUser.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'cpn-p4-owner' } });
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await CLEAN();
    const tenant = await prisma.raw.tenant.create({ data: { name: '卡券测试', code: 'cpn-p4' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'cpn-p4-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    communityId = (await prisma.raw.community.create({ data: { tenantId, name: '卡券小区' } })).id;
    houseId = (await prisma.raw.house.create({ data: { tenantId, communityId, code: 'p-101', displayName: 'p101', area: 100 } })).id;

    const wx = await request(app.getHttpServer()).post('/api/v1/auth/wx-login').send({ code: 'mock:cpn-p4-owner' });
    ownerToken = wx.body.data.token;
    const user = await prisma.raw.wxUser.findUnique({ where: { openid: 'cpn-p4-owner' } });
    await prisma.raw.houseBinding.create({ data: { tenantId, wxUserId: user!.id, houseId, status: 'ACTIVE', source: 'PHONE_MATCH' } });
    const login = await request(app.getHttpServer()).post('/api/v1/admin/auth/login').send({ username: 'cpn-p4-adm', password: 'p123456' });
    adminToken = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  it('管理端发券（物业费满100减10，限领1张，总量2）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ communityId, name: '物业费满100减10', type: 'DISCOUNT', faceValue: 10, threshold: 100, totalQty: 2, perUserLimit: 1, validFrom: '2026-01-01', validTo: '2026-12-31' })
      .expect(200);
    expect(res.body.code).toBe(0);
    couponId = res.body.data.id;
  });

  it('业主看到可领券，剩余 2', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/owner/coupons?houseId=${houseId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].remaining).toBe(2);
  });

  it('领取生成核销码', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/owner/coupons/${couponId}/claim`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.code).toMatch(/^[A-Z0-9]{8}$/);
    claimCode = res.body.data.code;
  });

  it('超过每人限领数被拒 45004', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/owner/coupons/${couponId}/claim`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.code).toBe(45004);
  });

  it('我的卡券含该券', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/owner/my/coupons')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.list[0].status).toBe('UNUSED');
    expect(res.body.data.list[0].coupon.name).toBe('物业费满100减10');
  });

  it('管理端核销 → 重复核销被拒', async () => {
    const v = await request(app.getHttpServer())
      .post(`/api/v1/admin/coupons/verify/${claimCode}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(v.body.data.status).toBe('USED');
    const again = await request(app.getHttpServer())
      .post(`/api/v1/admin/coupons/verify/${claimCode}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(again.body.code).toBe(45005);
  });
});
