import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('出账批次：幂等生成', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let communityId: string;
  let token: string;
  let areaRuleId: string;
  let shareRuleId: string;
  let houseNoAreaId: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'run-t12' } });
    if (t) {
      await prisma.raw.notifyLog.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.bill.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.billRun.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.sharePool.deleteMany({ where: { tenantId: t.id } });
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
    const tenant = await prisma.raw.tenant.create({ data: { name: '出账测试物业', code: 'run-t12' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'run-t12-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    const community = await prisma.raw.community.create({ data: { tenantId, name: '出账测试小区' } });
    communityId = community.id;
    await prisma.raw.house.create({
      data: { tenantId, communityId, code: 'r-101', displayName: '101', area: 100 },
    });
    await prisma.raw.house.create({
      data: { tenantId, communityId, code: 'r-102', displayName: '102', area: 50 },
    });
    const noArea = await prisma.raw.house.create({
      data: { tenantId, communityId, code: 'r-103', displayName: '103', area: null },
    });
    houseNoAreaId = noArea.id;

    const areaRule = await prisma.raw.feeRule.create({
      data: {
        tenantId, communityId, name: '物业费', houseType: 'RESIDENCE', ruleType: 'AREA_PRICE',
        params: { unitPrice: 2 }, period: 'MONTHLY', billDay: 1, dueDays: 15,
      },
    });
    areaRuleId = areaRule.id;
    const shareRule = await prisma.raw.feeRule.create({
      data: {
        tenantId, communityId, name: '公共能耗', houseType: 'RESIDENCE', ruleType: 'SHARE',
        params: { shareBy: 'AREA' }, period: 'MONTHLY', billDay: 1, dueDays: 15,
      },
    });
    shareRuleId = shareRule.id;

    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'run-t12-adm', password: 'p123456' });
    token = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  const trigger = (ruleId: string, period: string) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/bill-runs')
      .set('Authorization', `Bearer ${token}`)
      .send({ ruleId, period });

  it('AREA_PRICE：3 房其一无面积 → generated 2, skipped 1', async () => {
    const res = await trigger(areaRuleId, '2026-07').expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.generated).toBe(2);
    expect(res.body.data.skipped).toBe(1);

    const bills = await prisma.raw.bill.findMany({ where: { ruleId: areaRuleId, period: '2026-07' } });
    expect(bills).toHaveLength(2);
    const amounts = bills.map((b) => Number(b.amount)).sort((a, b) => a - b);
    expect(amounts).toEqual([100, 200]); // 2元 × 50/100 ㎡
    expect(bills[0].title).toBe('物业费 2026-07');
  });

  it('重跑：generated 0（幂等）', async () => {
    const res = await trigger(areaRuleId, '2026-07').expect(200);
    expect(res.body.data.generated).toBe(0);
    const count = await prisma.raw.bill.count({ where: { ruleId: areaRuleId, period: '2026-07' } });
    expect(count).toBe(2);
  });

  it('补面积后重跑：只补缺的 1 张', async () => {
    await prisma.raw.house.update({ where: { id: houseNoAreaId }, data: { area: 80 } });
    const res = await trigger(areaRuleId, '2026-07').expect(200);
    expect(res.body.data.generated).toBe(1);
    const count = await prisma.raw.bill.count({ where: { ruleId: areaRuleId, period: '2026-07' } });
    expect(count).toBe(3);
  });

  it('SHARE：缺公摊总额 → 批次 FAILED', async () => {
    const res = await trigger(shareRuleId, '2026-07').expect(200);
    expect(res.body.data.generated).toBe(0);
    const run = await prisma.raw.billRun.findUnique({
      where: { ruleId_period: { ruleId: shareRuleId, period: '2026-07' } },
    });
    expect(run?.status).toBe('FAILED');
  });

  it('补公摊总额后重跑：DONE 且分摊总额守恒', async () => {
    await prisma.raw.sharePool.create({
      data: { tenantId, ruleId: shareRuleId, period: '2026-07', totalAmount: 100.01 },
    });
    const res = await trigger(shareRuleId, '2026-07').expect(200);
    expect(res.body.data.generated).toBe(3);
    const bills = await prisma.raw.bill.findMany({ where: { ruleId: shareRuleId, period: '2026-07' } });
    const sumCents = bills.reduce((s, b) => s + Math.round(Number(b.amount) * 100), 0);
    expect(sumCents).toBe(10001);
  });

  it('账单作废：仅 UNPAID 可作废', async () => {
    const bill = await prisma.raw.bill.findFirst({ where: { ruleId: areaRuleId, period: '2026-07' } });
    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/bills/${bill!.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.code).toBe(0);
    const after = await prisma.raw.bill.findUnique({ where: { id: bill!.id } });
    expect(after?.status).toBe('CANCELED');

    const again = await request(app.getHttpServer())
      .post(`/api/v1/admin/bills/${bill!.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(again.body.code).toBe(43001);
  });

  it('后台账单查询', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/admin/bills?communityId=${communityId}&period=2026-07`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.data.total).toBe(6); // 3 物业费 + 3 公摊
  });
});
