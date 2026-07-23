import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

function execSql(sql: string): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('offline E2E requires DATABASE_URL');
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

describe('线下缴费核销与冲正', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let communityId: string;
  let houseId: string;
  let token: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'off-t20' } });
    if (t) {
      await prisma.raw.reconciliationItem.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.refundAttempt.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.paymentEvent.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.invoiceApplication.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.refund.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.paymentBill.deleteMany({ where: { payment: { tenantId: t.id } } });
      await prisma.raw.payment.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.bill.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.billBatch.deleteMany({ where: { tenantId: t.id } });
      purgeAuditLogs(t.id);
      await prisma.raw.idempotencyRecord.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.outboxEvent.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.feeRule.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.adminUser.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
  };

  const makeBill = async (period: string) => {
    const b = await prisma.raw.bill.create({
      data: {
        tenantId, communityId, houseId, period, title: `物业费 ${period}`,
        snapshot: {}, amount: '100.00', status: 'UNPAID', source: 'RULE',
        publishedAt: new Date(), dueDate: new Date('2026-08-31T00:00:00.000Z'),
      },
    });
    return b.id;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await CLEAN();
    const tenant = await prisma.raw.tenant.create({ data: { name: '线下测试物业', code: 'off-t20' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'off-t20-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    const community = await prisma.raw.community.create({ data: { tenantId, name: '线下测试小区' } });
    communityId = community.id;
    const house = await prisma.raw.house.create({ data: { tenantId, communityId, code: 'o-101', displayName: 'o101', area: 50 } });
    houseId = house.id;
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'off-t20-adm', password: 'p123456' });
    token = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

  let orderNo: string;

  it('线下核销：账单 PAID、生成 SUCCESS/OFFLINE 支付与收据', async () => {
    const billId = await makeBill('2026-07');
    const res = await auth(request(app.getHttpServer()).post('/api/v1/admin/payments/offline'))
      .send({ billId, voucherNo: 'VCH-001', paidAt: '2026-07-10T00:00:00.000Z', payerName: '张三', requestId: 'off-req-1' })
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.status).toBe('SUCCESS');
    orderNo = res.body.data.orderNo;

    const bill = await prisma.raw.bill.findUnique({ where: { id: billId } });
    expect(bill?.status).toBe('PAID');
    const payment = await prisma.raw.payment.findUnique({ where: { orderNo } });
    expect(payment?.channel).toBe('OFFLINE');
    expect(payment?.offlineVoucherNo).toBe('VCH-001');
    expect(payment?.receiptSnapshot).toBeTruthy();
    const audit = await prisma.raw.auditLog.findFirst({ where: { tenantId, action: 'PAY', resourceType: 'Payment' } });
    expect(audit).toBeTruthy();
  });

  it('相同 requestId 幂等：返回同一订单', async () => {
    const bill = await prisma.raw.bill.findFirst({ where: { tenantId, period: '2026-07' } });
    const res = await auth(request(app.getHttpServer()).post('/api/v1/admin/payments/offline'))
      .send({ billId: bill!.id, voucherNo: 'VCH-001', paidAt: '2026-07-10T00:00:00.000Z', payerName: '张三', requestId: 'off-req-1' })
      .expect(200);
    expect(res.body.data.orderNo).toBe(orderNo);
  });

  it('凭证号唯一：重复凭证号被拒', async () => {
    const billId = await makeBill('2026-08');
    const res = await auth(request(app.getHttpServer()).post('/api/v1/admin/payments/offline'))
      .send({ billId, voucherNo: 'VCH-001', paidAt: '2026-08-10T00:00:00.000Z', payerName: '李四', requestId: 'off-req-2' })
      .expect(200);
    expect(res.body.code).toBe(40000);
  });

  it('线下冲正：账单与订单转 REFUNDED', async () => {
    const res = await auth(request(app.getHttpServer()).post(`/api/v1/admin/payments/${orderNo}/reverse-offline`))
      .send({ reason: '误收退款', requestId: 'rev-req-1' })
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.status).toBe('SUCCESS');
    const payment = await prisma.raw.payment.findUnique({ where: { orderNo } });
    expect(payment?.status).toBe('REFUNDED');
    const refund = await prisma.raw.refund.findFirst({ where: { paymentOrderNo: orderNo } });
    expect(refund?.channel).toBe('OFFLINE');
    expect(refund?.status).toBe('SUCCESS');
  });

  it('未缴账单校验：非 UNPAID 不可核销', async () => {
    const bill = await prisma.raw.bill.findFirst({ where: { tenantId, period: '2026-07' } });
    const res = await auth(request(app.getHttpServer()).post('/api/v1/admin/payments/offline'))
      .send({ billId: bill!.id, voucherNo: 'VCH-XXX', paidAt: '2026-07-10T00:00:00.000Z', requestId: 'off-req-9' })
      .expect(200);
    expect(res.body.code).toBe(43001);
  });
});
