import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('物业工作照片墙', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let communityA: string;
  let communityB: string;
  let houseA: string;
  let ownerToken: string;
  let adminToken: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'wl-p2' } });
    if (t) {
      await prisma.raw.workLog.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.houseBinding.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.adminUser.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'wl-p2-owner' } });
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await CLEAN();
    const tenant = await prisma.raw.tenant.create({ data: { name: '照片墙测试物业', code: 'wl-p2' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'wl-p2-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    communityA = (await prisma.raw.community.create({ data: { tenantId, name: 'A 区' } })).id;
    communityB = (await prisma.raw.community.create({ data: { tenantId, name: 'B 区' } })).id;
    houseA = (await prisma.raw.house.create({ data: { tenantId, communityId: communityA, code: 'w-101', displayName: 'w101', area: 88 } })).id;

    const wx = await request(app.getHttpServer()).post('/api/v1/auth/wx-login').send({ code: 'mock:wl-p2-owner' });
    ownerToken = wx.body.data.token;
    const user = await prisma.raw.wxUser.findUnique({ where: { openid: 'wl-p2-owner' } });
    await prisma.raw.houseBinding.create({ data: { tenantId, wxUserId: user!.id, houseId: houseA, status: 'ACTIVE', source: 'PHONE_MATCH' } });
    const login = await request(app.getHttpServer()).post('/api/v1/admin/auth/login').send({ username: 'wl-p2-adm', password: 'p123456' });
    adminToken = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  it('管理端发布照片（必须带图）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/work-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ communityId: communityA, category: 'INSPECTION', title: '早班巡检', description: '楼道消防栓检查', images: ['/uploads/202607/a.jpg', '/uploads/202607/b.jpg'], staffName: '保安王' })
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.images).toHaveLength(2);
  });

  it('无图被拒 40000', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/work-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ communityId: communityA, category: 'CLEANING', images: [] })
      .expect(200);
    expect(res.body.code).toBe(40000);
  });

  it('业主只看到本小区照片', async () => {
    // B 区也发一条
    await request(app.getHttpServer())
      .post('/api/v1/admin/work-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ communityId: communityB, category: 'GREENING', title: 'B区绿化', images: ['/uploads/202607/c.jpg'] });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/owner/work-logs?houseId=${houseA}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.list[0].title).toBe('早班巡检');
  });

  it('业主按分类筛选', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/owner/work-logs?houseId=${houseA}&category=CLEANING`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data.total).toBe(0);
  });
});
