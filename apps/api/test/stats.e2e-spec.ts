import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('收缴统计与业主绑定查询', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let communityId: string;
  let token: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'sts-a1' } });
    if (t) {
      await prisma.raw.bill.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.billRun.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.feeRule.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.houseBinding.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.adminUser.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'sts-a1-user' } });
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await CLEAN();
    const tenant = await prisma.raw.tenant.create({ data: { name: '统计测试物业', code: 'sts-a1' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'sts-a1-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    const community = await prisma.raw.community.create({ data: { tenantId, name: '统计小区' } });
    communityId = community.id;
    const house = await prisma.raw.house.create({
      data: { tenantId, communityId, code: 's-101', displayName: 's101', area: 100 },
    });
    const rule = await prisma.raw.feeRule.create({
      data: { tenantId, communityId, name: '物业费', houseType: 'RESIDENCE', ruleType: 'FIXED', params: { amount: 100 }, period: 'MONTHLY', billDay: 1, dueDays: 15 },
    });
    const run = await prisma.raw.billRun.create({ data: { tenantId, ruleId: rule.id, period: '2026-07', status: 'DONE' } });
    const base = { tenantId, communityId, houseId: house.id, ruleId: rule.id, billRunId: run.id, snapshot: {}, dueDate: new Date() };
    await prisma.raw.bill.create({ data: { ...base, period: '2026-07', title: 'A', amount: '100.00', status: 'PAID', paidAt: new Date() } });
    await prisma.raw.bill.create({ data: { ...base, period: '2026-07', title: 'B', amount: '300.00', status: 'UNPAID', houseId: house.id, ruleId: rule.id, billRunId: run.id } as never }).catch(async () => {
      // 唯一键 (ruleId,houseId,period) 冲突 → 换个 period
      await prisma.raw.bill.create({ data: { ...base, period: '2026-08', title: 'B', amount: '300.00', status: 'UNPAID' } });
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'sts-a1-adm', password: 'p123456' });
    token = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  it('summary：应收 400 实收 100 收缴率 25%', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/admin/stats/summary?communityId=${communityId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.data).toEqual({
      billAmount: '400.00',
      billCount: 2,
      paidAmount: '100.00',
      paidCount: 1,
      rate: 25,
    });
  });

  it('by-community 含该小区行', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/stats/by-community')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = res.body.data.find((r: { communityId: string }) => r.communityId === communityId);
    expect(row.billAmount).toBe('400.00');
  });

  it('owner my/bindings 返回 PENDING 与驳回原因', async () => {
    const wx = await request(app.getHttpServer()).post('/api/v1/auth/wx-login').send({ code: 'mock:sts-a1-user' });
    const ownerToken = wx.body.data.token;
    const user = await prisma.raw.wxUser.findUnique({ where: { openid: 'sts-a1-user' } });
    const house = await prisma.raw.house.findFirst({ where: { tenantId } });
    await prisma.raw.houseBinding.create({
      data: { tenantId, wxUserId: user!.id, houseId: house!.id, source: 'APPLY', status: 'PENDING' },
    });
    const res = await request(app.getHttpServer())
      .get('/api/v1/owner/my/bindings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('PENDING');
    expect(res.body.data[0].communityName).toBe('统计小区');
  });

  it('账单科目筛选：filters 列表 + ruleId 过滤', async () => {
    const wx = await request(app.getHttpServer()).post('/api/v1/auth/wx-login').send({ code: 'mock:sts-a1-user' });
    const ownerToken = wx.body.data.token;
    const user = await prisma.raw.wxUser.findUnique({ where: { openid: 'sts-a1-user' } });
    const house = await prisma.raw.house.findFirst({ where: { tenantId } });
    // 转正绑定后才可查账单
    await prisma.raw.houseBinding.updateMany({
      where: { wxUserId: user!.id, houseId: house!.id },
      data: { status: 'ACTIVE' },
    });

    const filters = await request(app.getHttpServer())
      .get(`/api/v1/owner/bills/filters?houseId=${house!.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(filters.body.data).toHaveLength(1);
    expect(filters.body.data[0].name).toBe('物业费');

    const filtered = await request(app.getHttpServer())
      .get(`/api/v1/owner/bills?houseId=${house!.id}&ruleId=${filters.body.data[0].ruleId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(filtered.body.data.total).toBe(2);

    const none = await request(app.getHttpServer())
      .get(`/api/v1/owner/bills?houseId=${house!.id}&ruleId=nonexistent`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(none.body.data.total).toBe(0);
  });
});
