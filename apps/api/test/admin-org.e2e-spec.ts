import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('管理端组织管理（租户/小区/房产导入/绑定审核）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superToken: string;
  let tenantAdminToken: string;
  let tenantId: string;
  let communityId: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'org-t8' } });
    if (t) {
      await prisma.raw.houseBinding.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.adminUser.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'org-t8-owner' } });
    await prisma.raw.adminUser.deleteMany({ where: { username: 'super-t8' } });
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await CLEAN();
    await prisma.raw.adminUser.create({
      data: {
        username: 'super-t8',
        passwordHash: await bcrypt.hash('super123', 10),
        name: '平台超管',
        role: 'SUPER_ADMIN',
      },
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'super-t8', password: 'super123' });
    superToken = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  it('超管创建租户并附带管理员账号', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/tenants')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ name: '组织测试物业', code: 'org-t8', adminUsername: 'org-t8-admin', adminPassword: 'AdminOrg123456' })
      .expect(200);
    expect(res.body.code).toBe(0);
    tenantId = res.body.data.id;

    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'org-t8-admin', password: 'AdminOrg123456' });
    expect(login.body.code).toBe(0);
    tenantAdminToken = login.body.data.token;
  });

  it('租户管理员不能访问租户管理接口', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/tenants')
      .set('Authorization', `Bearer ${tenantAdminToken}`)
      .expect(200);
    expect(res.body.code).toBe(40300);
  });

  it('租户管理员创建小区', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/communities')
      .set('Authorization', `Bearer ${tenantAdminToken}`)
      .send({ name: '组织测试小区', address: '测试路 1 号' })
      .expect(200);
    expect(res.body.code).toBe(0);
    communityId = res.body.data.id;
    expect(res.body.data.tenantId).toBe(tenantId);
  });

  it('批量导入房产：好2行/坏1行', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/houses/import')
      .set('Authorization', `Bearer ${tenantAdminToken}`)
      .send({
        communityId,
        rows: [
          { type: 'RESIDENCE', code: '1-1-101', displayName: '1栋1单元101', area: 89.5, ownerName: '张三', ownerPhone: '13711112222' },
          { type: 'PARKING', code: 'B1-001', displayName: '地下车位 B1-001' },
          { type: 'RESIDENCE', code: '1-1-102', displayName: '1栋1单元102' }, // 住宅缺面积 → 失败
        ],
      })
      .expect(200);
    expect(res.body.data.created).toBe(2);
    expect(res.body.data.failed).toHaveLength(1);
    expect(res.body.data.failed[0].index).toBe(2);
  });

  it('重复导入同 code 为更新而非报错', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/houses/import')
      .set('Authorization', `Bearer ${tenantAdminToken}`)
      .send({
        communityId,
        rows: [{ type: 'RESIDENCE', code: '1-1-101', displayName: '1栋1单元101', area: 90.0 }],
      })
      .expect(200);
    expect(res.body.data.updated).toBe(1);
  });

  it('绑定审核：通过申请', async () => {
    // 造一个业主与 PENDING 申请
    const wx = await request(app.getHttpServer()).post('/api/v1/auth/wx-login').send({ code: 'mock:org-t8-owner' });
    const user = await prisma.raw.wxUser.findUnique({ where: { openid: 'org-t8-owner' } });
    const house = await prisma.raw.house.findFirst({ where: { tenantId, code: '1-1-101' } });
    const binding = await prisma.raw.houseBinding.create({
      data: { tenantId, wxUserId: user!.id, houseId: house!.id, source: 'APPLY', status: 'PENDING' },
    });
    void wx;

    const list = await request(app.getHttpServer())
      .get('/api/v1/admin/bindings?status=PENDING')
      .set('Authorization', `Bearer ${tenantAdminToken}`)
      .expect(200);
    expect(list.body.data.list.map((b: { id: string }) => b.id)).toContain(binding.id);

    const review = await request(app.getHttpServer())
      .post(`/api/v1/admin/bindings/${binding.id}/review`)
      .set('Authorization', `Bearer ${tenantAdminToken}`)
      .send({ approve: true })
      .expect(200);
    expect(review.body.code).toBe(0);
    const after = await prisma.raw.houseBinding.findUnique({ where: { id: binding.id } });
    expect(after?.status).toBe('ACTIVE');
  });

  it('超管带 X-Tenant-Id 可查看该租户小区', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/communities')
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    expect(res.body.data.list.map((c: { id: string }) => c.id)).toContain(communityId);
  });
});
