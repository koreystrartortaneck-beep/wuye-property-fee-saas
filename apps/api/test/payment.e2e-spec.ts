import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * 通过 prisma db execute 子进程运行原始 SQL（含触发器 DDL）。
 * Prisma 客户端的 $executeRaw 走预处理协议，不支持 CREATE/DROP TRIGGER。
 */
function execSql(sql: string): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('payment E2E requires DATABASE_URL');
  const prismaCli = require.resolve('prisma/build/index.js');
  const result = spawnSync(
    process.execPath,
    [prismaCli, 'db', 'execute', '--stdin', '--url', url],
    { cwd: join(__dirname, '..'), input: sql, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url }, timeout: 60_000 },
  );
  if (result.status !== 0) {
    throw new Error(`execSql failed:\n${[result.stdout, result.stderr].filter(Boolean).join('\n')}`);
  }
}

/** AuditLog 追加只读触发器禁止 DELETE；测试清理临时摘除后按原定义重建。 */
function purgeAuditLogs(tenantId: string): void {
  execSql(
    "DROP TRIGGER IF EXISTS `AuditLog_before_delete_append_only`;\n" +
      `DELETE FROM \`AuditLog\` WHERE \`tenantId\` = '${tenantId}';\n` +
      "CREATE TRIGGER `AuditLog_before_delete_append_only` BEFORE DELETE ON `AuditLog` " +
      "FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AuditLog is append-only: DELETE is forbidden';",
  );
}

describe('支付闭环：出账 → 查账 → 合并支付 → PAID', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let communityId: string;
  let houseId: string;
  let ownerId: string;
  let adminToken: string;
  let ownerToken: string;
  let orderNo: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'pay-t15' } });
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
      await prisma.raw.reconciliationRun.deleteMany({ where: { tenantId: t.id } });
      purgeAuditLogs(t.id);
      await prisma.raw.idempotencyRecord.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.outboxEvent.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.communityCollectionPolicy.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenantCollectionPolicy.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.notifyLog.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.billRun.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.sharePool.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.feeRule.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.houseBinding.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.adminUser.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'pay-t15-user' } });
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await CLEAN();

    const tenant = await prisma.raw.tenant.create({ data: { name: '支付测试物业', code: 'pay-t15' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'pay-t15-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    const community = await prisma.raw.community.create({ data: { tenantId, name: '支付测试小区' } });
    communityId = community.id;
    const house = await prisma.raw.house.create({
      data: {
        tenantId, communityId: community.id, code: 'p-101', displayName: 'p101',
        area: 100, ownerPhone: '13511110000',
      },
    });
    houseId = house.id;

    // 三条规则 → 三张账单（物业费 200 + 固定 50 + 水费 0.6×20=12）
    const r1 = await prisma.raw.feeRule.create({
      data: { tenantId, communityId: community.id, name: '物业费', houseType: 'RESIDENCE', ruleType: 'AREA_PRICE', params: { unitPrice: 2 }, period: 'MONTHLY', billDay: 1, dueDays: 15 },
    });
    const r2 = await prisma.raw.feeRule.create({
      data: { tenantId, communityId: community.id, name: '垃圾清运费', houseType: 'RESIDENCE', ruleType: 'FIXED', params: { amount: 50 }, period: 'MONTHLY', billDay: 1, dueDays: 15 },
    });
    const r3 = await prisma.raw.feeRule.create({
      data: { tenantId, communityId: community.id, name: '水费', houseType: 'RESIDENCE', ruleType: 'METER', params: { unitPrice: 0.6, meterType: 'WATER' }, period: 'MONTHLY', billDay: 1, dueDays: 15 },
    });

    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'pay-t15-adm', password: 'p123456' });
    adminToken = adminLogin.body.data.token;

    // 抄表
    await request(app.getHttpServer())
      .post('/api/v1/admin/meter-readings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ houseId, meterType: 'WATER', period: '2026-07', value: 20 });

    // 出账三张
    for (const rule of [r1, r2, r3]) {
      await request(app.getHttpServer())
        .post('/api/v1/admin/bill-runs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ruleId: rule.id, period: '2026-07' });
    }

    // 业主登录 + 手机号绑定
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/wx-login')
      .send({ code: 'mock:pay-t15-user' });
    ownerToken = login.body.data.token;
    await request(app.getHttpServer())
      .post('/api/v1/auth/phone')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ code: 'phone:13511110000' });
    ownerId = (await prisma.raw.wxUser.findUnique({ where: { openid: 'pay-t15-user' } }))!.id;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  it('未缴汇总正确：262.00 / 3 笔', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/owner/bills/summary')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data).toEqual({ unpaidTotal: '262.00', unpaidCount: 3 });
  });

  it('账单列表按房查询', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/owner/bills?houseId=${houseId}&status=UNPAID`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data.total).toBe(3);
  });

  let firstBillId: string;

  it('数组入参被拒（单账单契约只接受单个 billId）', async () => {
    const bills = await prisma.raw.bill.findMany({ where: { houseId } });
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/payments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ billIds: bills.map((b) => b.id) })
      .expect(200);
    expect(res.body.code).toBe(40000);
  });

  it('单账单下单：billId + requestId', async () => {
    const bill = await prisma.raw.bill.findFirst({ where: { houseId, status: 'UNPAID' } });
    firstBillId = bill!.id;
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/payments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ billId: firstBillId, requestId: 'e2e-req-1' })
      .expect(200);
    expect(res.body.code).toBe(0);
    orderNo = res.body.data.orderNo;
    expect(orderNo).toMatch(/^WY\d{14}$/);

    const payment = await prisma.raw.payment.findUnique({ where: { orderNo } });
    // 新订单写入单账单归属与小区快照
    expect(payment!.billId).toBe(firstBillId);
    expect(payment!.communityId).toBe(communityId);
  });

  it('相同 requestId 幂等重放，返回同一订单', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/payments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ billId: firstBillId, requestId: 'e2e-req-1' })
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.orderNo).toBe(orderNo);
  });

  it('进行中订单占用账单，换 requestId 重复下单被拒 43002', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/payments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ billId: firstBillId, requestId: 'e2e-req-2' })
      .expect(200);
    expect(res.body.code).toBe(43002);
  });

  it('mock 确认：订单 SUCCESS、该账单 PAID', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/owner/payments/${orderNo}/mock-confirm`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data.status).toBe('SUCCESS');

    const bill = await prisma.raw.bill.findUnique({ where: { id: firstBillId } });
    expect(bill!.status).toBe('PAID');
  });

  it('重复确认幂等', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/owner/payments/${orderNo}/mock-confirm`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data.status).toBe('SUCCESS');
  });

  it('已 PAID 账单再下单被拒 43001', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/payments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ billId: firstBillId, requestId: 'e2e-req-3' })
      .expect(200);
    expect(res.body.code).toBe(43001);
  });

  it('缴费记录含单张账单明细', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/owner/payments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.list[0].bills).toHaveLength(1);
  });

  it('确认页 quote 复核账单金额与收款状态', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/owner/payments/quote/${firstBillId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.billId).toBe(firstBillId);
    expect(res.body.data.collection.status).toBe('OPEN');
    // 已支付账单不可再缴
    expect(res.body.data.payable).toBe(false);
  });

  it('他人不可见此订单', async () => {
    const other = await request(app.getHttpServer())
      .post('/api/v1/auth/wx-login')
      .send({ code: 'mock:pay-t15-other' });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/owner/payments/${orderNo}`)
      .set('Authorization', `Bearer ${other.body.data.token}`)
      .expect(200);
    expect(res.body.code).toBe(40400);
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'pay-t15-other' } });
  });

  it('旧式跨小区多账单订单仍由 PaymentBill 完整读取', async () => {
    const secondCommunity = await prisma.raw.community.create({
      data: { tenantId, name: '支付测试第二小区' },
    });
    const secondHouse = await prisma.raw.house.create({
      data: {
        tenantId,
        communityId: secondCommunity.id,
        code: 'p-201',
        displayName: 'p201',
        area: 80,
      },
    });
    const firstRule = await prisma.raw.feeRule.create({
      data: {
        tenantId,
        communityId,
        name: '历史账单A',
        ruleType: 'FIXED',
        params: { amount: 10 },
      },
    });
    const secondRule = await prisma.raw.feeRule.create({
      data: {
        tenantId,
        communityId: secondCommunity.id,
        name: '历史账单B',
        ruleType: 'FIXED',
        params: { amount: 20 },
      },
    });
    const firstRun = await prisma.raw.billRun.create({
      data: { tenantId, ruleId: firstRule.id, period: '2026-08', status: 'DONE' },
    });
    const secondRun = await prisma.raw.billRun.create({
      data: { tenantId, ruleId: secondRule.id, period: '2026-08', status: 'DONE' },
    });
    const paidAt = new Date('2026-08-20T00:00:00.000Z');
    const historicalPayment = await prisma.raw.payment.create({
      data: {
        tenantId,
        wxUserId: ownerId,
        orderNo: 'LEGACY-PAY-T15',
        totalAmount: '30.00',
        channel: 'MOCK',
        status: 'SUCCESS',
        transactionId: 'LEGACY-TXN-T15',
        paidAt,
      },
    });
    const firstBill = await prisma.raw.bill.create({
      data: {
        tenantId,
        communityId,
        houseId,
        ruleId: firstRule.id,
        billRunId: firstRun.id,
        period: '2026-08',
        title: '历史账单A 2026-08',
        snapshot: {},
        amount: '10.00',
        status: 'PAID',
        dueDate: paidAt,
        paidAt,
      },
    });
    const secondBill = await prisma.raw.bill.create({
      data: {
        tenantId,
        communityId: secondCommunity.id,
        houseId: secondHouse.id,
        ruleId: secondRule.id,
        billRunId: secondRun.id,
        period: '2026-08',
        title: '历史账单B 2026-08',
        snapshot: {},
        amount: '20.00',
        status: 'PAID',
        dueDate: paidAt,
        paidAt,
      },
    });
    await prisma.raw.paymentBill.createMany({
      data: [firstBill, secondBill].map((bill) => ({ paymentId: historicalPayment.id, billId: bill.id })),
    });

    const stored = await prisma.raw.payment.findUnique({
      where: { id: historicalPayment.id },
      select: {
        billId: true,
        communityId: true,
        paymentBills: { include: { bill: { select: { title: true, communityId: true } } } },
      },
    });
    expect(stored?.billId).toBeNull();
    expect(stored?.communityId).toBeNull();
    expect(stored?.paymentBills.map((item) => item.bill.title).sort()).toEqual([
      '历史账单A 2026-08',
      '历史账单B 2026-08',
    ]);
    expect(new Set(stored?.paymentBills.map((item) => item.bill.communityId))).toEqual(
      new Set([communityId, secondCommunity.id]),
    );

    const res = await request(app.getHttpServer())
      .get('/api/v1/owner/payments/LEGACY-PAY-T15')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data.bills.map((bill: { title: string }) => bill.title).sort()).toEqual([
      '历史账单A 2026-08',
      '历史账单B 2026-08',
    ]);
  });
});
