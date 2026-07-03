import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotifyService } from '../src/notify/notify.service';

describe('通知模块：出账推送与提醒去重', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let token: string;
  let ruleId: string;
  let boundHouseId: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'ntf-t14' } });
    if (t) {
      await prisma.raw.notifyLog.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.bill.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.billRun.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.feeRule.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.houseBinding.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.adminUser.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'ntf-t14-user' } });
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await CLEAN();
    const tenant = await prisma.raw.tenant.create({ data: { name: '通知测试物业', code: 'ntf-t14' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'ntf-t14-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    const community = await prisma.raw.community.create({ data: { tenantId, name: '通知测试小区' } });
    const bound = await prisma.raw.house.create({
      data: { tenantId, communityId: community.id, code: 'n-101', displayName: 'n101', area: 100 },
    });
    boundHouseId = bound.id;
    await prisma.raw.house.create({
      data: { tenantId, communityId: community.id, code: 'n-102', displayName: 'n102', area: 60 },
    });
    const user = await prisma.raw.wxUser.create({ data: { openid: 'ntf-t14-user' } });
    await prisma.raw.houseBinding.create({
      data: { tenantId, wxUserId: user.id, houseId: bound.id, status: 'ACTIVE', source: 'PHONE_MATCH' },
    });
    const rule = await prisma.raw.feeRule.create({
      data: {
        tenantId, communityId: community.id, name: '物业费', houseType: 'RESIDENCE', ruleType: 'AREA_PRICE',
        params: { unitPrice: 2 }, period: 'MONTHLY', billDay: 1, dueDays: 15,
      },
    });
    ruleId = rule.id;
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'ntf-t14-adm', password: 'p123456' });
    token = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  it('出账后：绑定房 SENT、未绑定房 SKIPPED', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/bill-runs')
      .set('Authorization', `Bearer ${token}`)
      .send({ ruleId, period: '2026-07' })
      .expect(200);

    const logs = await prisma.raw.notifyLog.findMany({ where: { tenantId, type: 'BILL_CREATED' } });
    expect(logs).toHaveLength(2);
    const sent = logs.find((l) => l.status === 'SENT');
    const skipped = logs.find((l) => l.status === 'SKIPPED');
    expect(sent).toBeTruthy();
    expect(skipped).toBeTruthy();
  });

  it('提醒去重：同账单同类型只发一次', async () => {
    const bill = await prisma.raw.bill.findFirst({ where: { tenantId, houseId: boundHouseId } });
    const notify = app.get(NotifyService);
    await notify.onReminder(bill!, 'DUE_SOON');
    await notify.onReminder(bill!, 'DUE_SOON');
    const count = await prisma.raw.notifyLog.count({
      where: { billId: bill!.id, type: 'DUE_SOON', status: 'SENT' },
    });
    expect(count).toBe(1);
  });
});
