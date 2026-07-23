import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotifyService } from '../src/notify/notify.service';

function execSql(sql: string): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('notify E2E requires DATABASE_URL');
  const prismaCli = require.resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'db', 'execute', '--stdin', '--url', url], {
    cwd: join(__dirname, '..'), input: sql, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url }, timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`execSql failed:\n${[result.stdout, result.stderr].filter(Boolean).join('\n')}`);
}

function purgeAuditLogs(tenantId: string): void {
  execSql(
    "DROP TRIGGER IF EXISTS `AuditLog_before_delete_append_only`;\n" +
      `DELETE FROM \`AuditLog\` WHERE \`tenantId\` = '${tenantId}';\n` +
      "CREATE TRIGGER `AuditLog_before_delete_append_only` BEFORE DELETE ON `AuditLog` " +
      "FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AuditLog is append-only: DELETE is forbidden';",
  );
}

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
      await prisma.raw.billBatch.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.billRun.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.outboxEvent.deleteMany({ where: { tenantId: t.id } });
      purgeAuditLogs(t.id);
      await prisma.raw.idempotencyRecord.deleteMany({ where: { tenantId: t.id } });
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

  it('发布后：绑定房 SENT、未绑定房 SKIPPED', async () => {
    const gen = await request(app.getHttpServer())
      .post('/api/v1/admin/bill-runs')
      .set('Authorization', `Bearer ${token}`)
      .send({ ruleId, period: '2026-07' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/bill-batches/${gen.body.data.batchId}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({ requestId: 'ntf-pub-1' })
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
