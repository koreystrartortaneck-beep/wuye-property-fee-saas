import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('计费配置：规则/抄表/公摊', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let communityId: string;
  let houseId: string;
  let token: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'cfg-t11' } });
    if (t) {
      await prisma.raw.sharePool.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.meterReading.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.feeRule.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.adminUser.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await CLEAN();
    const tenant = await prisma.raw.tenant.create({ data: { name: '配置测试物业', code: 'cfg-t11' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'cfg-t11-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    const community = await prisma.raw.community.create({ data: { tenantId, name: '配置测试小区' } });
    communityId = community.id;
    const house = await prisma.raw.house.create({
      data: { tenantId, communityId, code: '3-1-301', displayName: '3栋1单元301', area: 100 },
    });
    houseId = house.id;
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'cfg-t11-adm', password: 'p123456' });
    token = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  const post = (url: string, body: object) =>
    request(app.getHttpServer()).post(`/api/v1/admin${url}`).set('Authorization', `Bearer ${token}`).send(body);

  it('创建 4 类规则成功', async () => {
    const cases = [
      { name: '物业管理费', ruleType: 'AREA_PRICE', params: { unitPrice: 2.5 }, houseType: 'RESIDENCE', period: 'MONTHLY', billDay: 1, dueDays: 15 },
      { name: '车位管理费', ruleType: 'FIXED', params: { amount: 360 }, houseType: 'PARKING', period: 'MONTHLY', billDay: 1, dueDays: 15 },
      { name: '水费', ruleType: 'METER', params: { unitPrice: 3.5, meterType: 'WATER' }, houseType: 'RESIDENCE', period: 'MONTHLY', billDay: 5, dueDays: 10 },
      { name: '公共能耗', ruleType: 'SHARE', params: { shareBy: 'AREA' }, houseType: 'RESIDENCE', period: 'MONTHLY', billDay: 1, dueDays: 15 },
    ];
    for (const c of cases) {
      const res = await post('/fee-rules', { ...c, communityId }).expect(200);
      expect(res.body.code).toBe(0);
    }
  });

  it('坏 params 被拒（42001/42005）', async () => {
    const bad1 = await post('/fee-rules', {
      name: '坏规则', ruleType: 'AREA_PRICE', params: { unitPrice: -1 }, houseType: 'RESIDENCE',
      period: 'MONTHLY', billDay: 1, dueDays: 15, communityId,
    }).expect(200);
    expect(bad1.body.code).toBe(42001);

    const bad2 = await post('/fee-rules', {
      name: '坏公式', ruleType: 'FORMULA', params: { expr: 'pow(2,3)', vars: {} }, houseType: 'RESIDENCE',
      period: 'MONTHLY', billDay: 1, dueDays: 15, communityId,
    }).expect(200);
    expect(bad2.body.code).toBe(42005);
  });

  it('billDay 超范围被拒', async () => {
    const res = await post('/fee-rules', {
      name: '坏出账日', ruleType: 'FIXED', params: { amount: 1 }, houseType: 'RESIDENCE',
      period: 'MONTHLY', billDay: 31, dueDays: 15, communityId,
    }).expect(200);
    expect(res.body.code).toBe(40000);
  });

  it('抄表录入与回退拒绝', async () => {
    const first = await post('/meter-readings', { houseId, meterType: 'WATER', period: '2026-06', value: 1200.3 }).expect(200);
    expect(first.body.code).toBe(0);

    const second = await post('/meter-readings', { houseId, meterType: 'WATER', period: '2026-07', value: 1234.5 }).expect(200);
    expect(second.body.code).toBe(0);
    expect(Number(second.body.data.prevValue)).toBe(1200.3);

    const backward = await post('/meter-readings', { houseId, meterType: 'WATER', period: '2026-08', value: 1000 }).expect(200);
    expect(backward.body.code).toBe(42002);
  });

  it('同期重复录入为覆盖更新', async () => {
    const res = await post('/meter-readings', { houseId, meterType: 'WATER', period: '2026-07', value: 1235.0 }).expect(200);
    expect(res.body.code).toBe(0);
    const n = await prisma.raw.meterReading.count({ where: { houseId, meterType: 'WATER', period: '2026-07' } });
    expect(n).toBe(1);
  });

  it('公摊总额 upsert', async () => {
    const rule = await prisma.raw.feeRule.findFirst({ where: { tenantId, ruleType: 'SHARE' } });
    const res1 = await request(app.getHttpServer())
      .put('/api/v1/admin/share-pools')
      .set('Authorization', `Bearer ${token}`)
      .send({ ruleId: rule!.id, period: '2026-07', totalAmount: 5000 })
      .expect(200);
    expect(res1.body.code).toBe(0);
    const res2 = await request(app.getHttpServer())
      .put('/api/v1/admin/share-pools')
      .set('Authorization', `Bearer ${token}`)
      .send({ ruleId: rule!.id, period: '2026-07', totalAmount: 5200 })
      .expect(200);
    expect(Number(res2.body.data.totalAmount)).toBe(5200);
  });
});
