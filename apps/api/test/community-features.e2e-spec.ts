import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('公告可见范围 + 访客核销 + 管家电话', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let communityA: string;
  let communityB: string;
  let houseA: string;
  let ownerToken: string;
  let adminToken: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'cmf-w4' } });
    if (t) {
      await prisma.raw.visitorPass.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.announcement.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.houseBinding.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.adminUser.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'cmf-w4-owner' } });
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await CLEAN();
    const tenant = await prisma.raw.tenant.create({ data: { name: '社区测试物业', code: 'cmf-w4' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'cmf-w4-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    const ca = await prisma.raw.community.create({
      data: { tenantId, name: 'A 区', servicePhone: '400-000-1111' },
    });
    communityA = ca.id;
    const cb = await prisma.raw.community.create({ data: { tenantId, name: 'B 区' } });
    communityB = cb.id;
    const house = await prisma.raw.house.create({
      data: { tenantId, communityId: communityA, code: 'c-101', displayName: 'c101', area: 90 },
    });
    houseA = house.id;

    const wx = await request(app.getHttpServer()).post('/api/v1/auth/wx-login').send({ code: 'mock:cmf-w4-owner' });
    ownerToken = wx.body.data.token;
    const user = await prisma.raw.wxUser.findUnique({ where: { openid: 'cmf-w4-owner' } });
    await prisma.raw.houseBinding.create({
      data: { tenantId, wxUserId: user!.id, houseId: houseA, status: 'ACTIVE', source: 'PHONE_MATCH' },
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'cmf-w4-adm', password: 'p123456' });
    adminToken = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  it('公告可见范围：A 区公告 + 全司公告可见，B 区公告不可见', async () => {
    const post = (body: object) =>
      request(app.getHttpServer())
        .post('/api/v1/admin/announcements')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body);
    await post({ communityId: communityA, title: 'A区停水通知', content: '明日停水' }).expect(200);
    await post({ communityId: communityB, title: 'B区消杀通知', content: 'B区专属' }).expect(200);
    await post({ title: '全司致业主信', content: '全体可见', pinned: true }).expect(200);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/owner/announcements?houseId=${houseA}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const titles = res.body.data.map((a: { title: string }) => a.title);
    expect(titles).toContain('A区停水通知');
    expect(titles).toContain('全司致业主信');
    expect(titles).not.toContain('B区消杀通知');
    expect(titles[0]).toBe('全司致业主信'); // 置顶优先
  });

  it('撤回后业主不可见', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/v1/admin/announcements')
      .set('Authorization', `Bearer ${adminToken}`);
    const a = list.body.data.list.find((x: { title: string }) => x.title === 'A区停水通知');
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/announcements/${a.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'REVOKED' })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/owner/announcements?houseId=${houseA}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.body.data.map((x: { title: string }) => x.title)).not.toContain('A区停水通知');
  });

  it('访客通行证：创建 → 当日核销 → 重复核销被拒', async () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/owner/visitor-passes')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ houseId: houseA, visitorName: '张访客', plateNo: '吉A12345', visitDate: dateStr })
      .expect(200);
    expect(created.body.code).toBe(0);
    const { id, code } = created.body.data;
    expect(code).toMatch(/^\d{6}$/);

    // 管理端按码查到
    const found = await request(app.getHttpServer())
      .get(`/api/v1/admin/visitor-passes?code=${code}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(found.body.data.total).toBe(1);

    const verify = await request(app.getHttpServer())
      .post(`/api/v1/admin/visitor-passes/${id}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(verify.body.data.status).toBe('USED');

    const again = await request(app.getHttpServer())
      .post(`/api/v1/admin/visitor-passes/${id}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(again.body.code).toBe(44002);
  });

  it('昨天的日期不可创建', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/visitor-passes')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ houseId: houseA, visitorName: '李访客', visitDate: '2020-01-01' })
      .expect(200);
    expect(res.body.code).toBe(40000);
  });

  it('my/houses 返回管家电话', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/owner/my/houses')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data[0].servicePhone).toBe('400-000-1111');
  });
});
