import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockWechatBillProvider } from '../src/reconciliation/wechat-bill.provider';

function execSql(sql: string): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('reconciliation E2E requires DATABASE_URL');
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

describe('微信支付每日对账', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let billProvider: MockWechatBillProvider;
  let tenantId: string;
  let communityId: string;
  let token: string;
  const MERCHANT = 'RECON-T21-SERIAL';
  const onDate = new Date('2026-07-10T04:00:00.000Z');

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'recon-t21' } });
    if (t) {
      await prisma.raw.reconciliationItem.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.reconciliationRun.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.paymentBill.deleteMany({ where: { payment: { tenantId: t.id } } });
      await prisma.raw.payment.deleteMany({ where: { tenantId: t.id } });
      purgeAuditLogs(t.id);
      await prisma.raw.idempotencyRecord.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.adminUser.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    billProvider = app.get(MockWechatBillProvider);
    await CLEAN();
    const tenant = await prisma.raw.tenant.create({ data: { name: '对账测试物业', code: 'recon-t21' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'recon-t21-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    const community = await prisma.raw.community.create({ data: { tenantId, name: '对账测试小区' } });
    communityId = community.id;
    // 本地一笔 WXPAY 成功支付（账期 2026-07-10）
    await prisma.raw.payment.create({
      data: {
        tenantId, communityId, orderNo: 'WY-RECON-1', totalAmount: '100.00', channel: 'WXPAY', status: 'SUCCESS',
        merchantAccountId: MERCHANT, mchid: 'MCH', appid: 'APP', paidAt: onDate, confirmedBy: 'WXPAY_NOTIFY', confirmedAt: onDate,
      },
    });
    const login = await request(app.getHttpServer()).post('/api/v1/admin/auth/login').send({ username: 'recon-t21-adm', password: 'p123456' });
    token = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  const trigger = () =>
    auth(request(app.getHttpServer()).post('/api/v1/admin/reconciliations')).send({
      merchantAccountId: MERCHANT, mchid: 'MCH', appid: 'APP', communityId, businessDate: '2026-07-10T00:00:00.000Z', billType: 'TRANSACTION',
    });

  let runId: string;

  it('对账运行：渠道缺失本地成功单 → CHANNEL_MISSING 差异并写审计', async () => {
    billProvider.setNextBill({ trades: [] }); // 渠道空账期
    const res = await trigger().expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.status).toBe('COMPLETED');
    runId = res.body.data.runId;

    const items = await prisma.raw.reconciliationItem.findMany({ where: { runId } });
    expect(items).toHaveLength(1);
    expect(items[0].differenceType).toBe('CHANNEL_MISSING');
    expect(items[0].orderNo).toBe('WY-RECON-1');
    const audit = await prisma.raw.auditLog.findFirst({ where: { tenantId, action: 'RECONCILE', resourceType: 'ReconciliationRun' } });
    expect(audit).toBeTruthy();
  });

  it('同账期重复运行幂等：不新建 Run', async () => {
    const res = await trigger().expect(200);
    expect(res.body.data.runId).toBe(runId);
    const runs = await prisma.raw.reconciliationRun.count({ where: { tenantId, billType: 'TRANSACTION' } });
    expect(runs).toBe(1);
  });

  it('差异项列表与手工处置', async () => {
    const list = await auth(request(app.getHttpServer()).get(`/api/v1/admin/reconciliations/${runId}/items`)).expect(200);
    expect(list.body.data.total).toBe(1);
    const itemId = list.body.data.list[0].id;
    const res = await auth(request(app.getHttpServer()).post(`/api/v1/admin/reconciliations/items/${itemId}/resolve`))
      .send({ status: 'MANUALLY_CLOSED', remark: '已线下核实' })
      .expect(200);
    expect(res.body.data.status).toBe('MANUALLY_CLOSED');
    const item = await prisma.raw.reconciliationItem.findUnique({ where: { id: itemId } });
    expect(item?.status).toBe('MANUALLY_CLOSED');
  });
});
