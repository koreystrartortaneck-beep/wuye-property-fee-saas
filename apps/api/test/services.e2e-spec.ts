import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('生活服务：菜单 + 预约接单', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let communityId: string;
  let houseId: string;
  let ownerToken: string;
  let adminToken: string;
  let itemId: string;
  let orderId: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'svc-p3' } });
    if (t) {
      await prisma.raw.serviceOrder.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.serviceItem.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.houseBinding.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.adminUser.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'svc-p3-owner' } });
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await CLEAN();
    const tenant = await prisma.raw.tenant.create({ data: { name: '生活服务测试', code: 'svc-p3' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'svc-p3-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    communityId = (await prisma.raw.community.create({ data: { tenantId, name: '服务小区' } })).id;
    houseId = (await prisma.raw.house.create({ data: { tenantId, communityId, code: 's-101', displayName: 's101', area: 100 } })).id;

    const wx = await request(app.getHttpServer()).post('/api/v1/auth/wx-login').send({ code: 'mock:svc-p3-owner' });
    ownerToken = wx.body.data.token;
    const user = await prisma.raw.wxUser.findUnique({ where: { openid: 'svc-p3-owner' } });
    await prisma.raw.houseBinding.create({ data: { tenantId, wxUserId: user!.id, houseId, status: 'ACTIVE', source: 'PHONE_MATCH' } });
    const login = await request(app.getHttpServer()).post('/api/v1/admin/auth/login').send({ username: 'svc-p3-adm', password: 'p123456' });
    adminToken = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  it('管理端创建服务菜单', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/service-items')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ communityId, name: '日常保洁', category: '保洁', price: 60, unit: '元/时段', description: '2 小时上门保洁' })
      .expect(200);
    expect(res.body.code).toBe(0);
    itemId = res.body.data.id;
  });

  it('业主看到可预约服务', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/owner/service-items?houseId=${houseId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('日常保洁');
  });

  it('业主下单预约（金额快照）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/service-orders')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ houseId, serviceItemId: itemId, contactName: '张三', contactPhone: '13800000000', expectDate: '2026-08-01', remark: '下午来' })
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(Number(res.body.data.price)).toBe(60);
    expect(res.body.data.status).toBe('PENDING');
    orderId = res.body.data.id;
  });

  it('管理端接单 → 完成', async () => {
    const a = await request(app.getHttpServer())
      .post(`/api/v1/admin/service-orders/${orderId}/accept`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(a.body.data.status).toBe('ACCEPTED');
    const d = await request(app.getHttpServer())
      .post(`/api/v1/admin/service-orders/${orderId}/done`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(d.body.data.status).toBe('DONE');
  });

  it('已接单的预约业主不能取消', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/owner/service-orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.code).toBe(45001);
  });

  it('下架的服务不能下单', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/service-items/${itemId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: false });
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/service-orders')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ houseId, serviceItemId: itemId, contactName: '张三', contactPhone: '13800000000', expectDate: '2026-08-02' })
      .expect(200);
    expect(res.body.code).toBe(45002);
  });
});
