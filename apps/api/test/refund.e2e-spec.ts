import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  CreateRefundInput,
  PAYMENT_PROVIDER,
  PaymentProvider,
  PaymentProviderError,
  WxPayRefund,
} from '../src/payment/provider';

function execSql(sql: string): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('refund E2E requires DATABASE_URL');
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

/** 可编程的假支付渠道：驱动退款各分支。 */
const refundControl = { mode: 'SUCCESS' as 'SUCCESS' | 'REJECT' | 'PROCESSING', queryStatus: 'SUCCESS' };
const fakeProvider: PaymentProvider = {
  createOrder: async () => ({ mock: false }),
  close: async () => {},
  queryOrder: async (orderNo: string) => ({
    appid: 'wx', mchid: '1900000109', out_trade_no: orderNo, transaction_id: 'TXN',
    trade_state: 'SUCCESS', amount: { total: 100, currency: 'CNY' },
  }),
  createRefund: async (input: CreateRefundInput): Promise<WxPayRefund> => {
    if (refundControl.mode === 'REJECT') throw new PaymentProviderError(400, 'NOTENOUGH', '余额不足');
    return {
      refund_id: `RID-${input.outRefundNo}`, out_refund_no: input.outRefundNo, out_trade_no: input.outTradeNo,
      transaction_id: 'TXN', status: refundControl.mode === 'PROCESSING' ? 'PROCESSING' : 'SUCCESS',
      amount: { total: input.totalCents, refund: input.refundCents },
    };
  },
  queryRefund: async (outRefundNo: string): Promise<WxPayRefund> => ({
    refund_id: `RID-${outRefundNo}`, out_refund_no: outRefundNo, status: refundControl.queryStatus,
    amount: { total: 100, refund: 100 },
  }),
};

describe('退款闭环：全额退款 / 幂等 / 失败恢复 / 历史订单', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let communityId: string;
  let community2Id: string;
  let houseId: string;
  let house2Id: string;
  let adminToken: string;
  let ownerId: string;
  let ownerToken: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'refund-t' } });
    if (t) {
      await prisma.raw.paymentEvent.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.refundAttempt.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.refund.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.paymentBill.deleteMany({ where: { payment: { tenantId: t.id } } });
      await prisma.raw.payment.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.bill.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.idempotencyRecord.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.outboxEvent.deleteMany({ where: { tenantId: t.id } });
      purgeAuditLogs(t.id);
      await prisma.raw.houseBinding.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.adminUser.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'refund-owner' } });
  };

  let seq = 0;
  async function seedPayment(opts: { communityIds: string[]; withOwner?: boolean }): Promise<string> {
    seq += 1;
    const orderNo = `WYREFUND${String(seq).padStart(6, '0')}`;
    const primaryCommunity = opts.communityIds[0];
    const primaryHouse = primaryCommunity === communityId ? houseId : house2Id;
    const singleCommunity = opts.communityIds.length === 1 ? primaryCommunity : null;
    const payment = await prisma.raw.payment.create({
      data: {
        tenantId,
        communityId: singleCommunity,
        wxUserId: opts.withOwner ? ownerId : null,
        billId: null,
        orderNo,
        totalAmount: '1.00',
        channel: 'WXPAY',
        status: 'SUCCESS',
        transactionId: `TXN-${orderNo}`,
        mchid: '1900000109',
        appid: 'wx-appid',
        merchantAccountId: 'SERIAL',
        paidAt: new Date(),
        receiptNo: `RCPT-${orderNo}`,
        receiptSnapshot: { orderNo, receiptNo: `RCPT-${orderNo}` },
        confirmedBy: 'WXPAY_QUERY',
      },
    });
    for (const cid of opts.communityIds) {
      const hId = cid === communityId ? houseId : house2Id;
      const bill = await prisma.raw.bill.create({
        data: {
          tenantId, communityId: cid, houseId: hId, period: '2026-07',
          title: '物业费', snapshot: {}, amount: '1.00', status: 'PAID',
          dueDate: new Date(), paidAt: new Date(), paymentId: payment.id,
        },
      });
      await prisma.raw.paymentBill.create({ data: { paymentId: payment.id, billId: bill.id } });
    }
    return orderNo;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(fakeProvider)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    await CLEAN();

    const tenant = await prisma.raw.tenant.create({ data: { name: '退款测试物业', code: 'refund-t' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'refund-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    const c1 = await prisma.raw.community.create({ data: { tenantId, name: '退款小区一' } });
    communityId = c1.id;
    const c2 = await prisma.raw.community.create({ data: { tenantId, name: '退款小区二' } });
    community2Id = c2.id;
    const h1 = await prisma.raw.house.create({ data: { tenantId, communityId, code: 'r-101', displayName: 'r101', area: 100 } });
    houseId = h1.id;
    const h2 = await prisma.raw.house.create({ data: { tenantId, communityId: community2Id, code: 'r-201', displayName: 'r201', area: 80 } });
    house2Id = h2.id;

    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'refund-adm', password: 'p123456' });
    adminToken = adminLogin.body.data.token;

    const login = await request(app.getHttpServer()).post('/api/v1/auth/wx-login').send({ code: 'mock:refund-owner' });
    ownerToken = login.body.data.token;
    ownerId = (await prisma.raw.wxUser.findUnique({ where: { openid: 'refund-owner' } }))!.id;
    await prisma.raw.houseBinding.create({ data: { tenantId, wxUserId: ownerId, houseId, status: 'ACTIVE', relation: 'OWNER', source: 'APPLY' } });
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  beforeEach(() => { refundControl.mode = 'SUCCESS'; refundControl.queryStatus = 'SUCCESS'; });

  it('全额退款成功：订单 REFUNDED、账单 REFUNDED、退款单 SUCCESS、留有外呼记录', async () => {
    const orderNo = await seedPayment({ communityIds: [communityId], withOwner: true });
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/refunds')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ orderNo, reason: '业主申请全额退款', requestId: `rq-${orderNo}` })
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.status).toBe('SUCCESS');

    const payment = await prisma.raw.payment.findUnique({ where: { orderNo } });
    expect(payment!.status).toBe('REFUNDED');
    const bills = await prisma.raw.bill.findMany({ where: { paymentId: payment!.id } });
    expect(bills.every((b) => b.status === 'REFUNDED')).toBe(true);
    const refund = await prisma.raw.refund.findUnique({ where: { paymentId: payment!.id }, include: { attempts: true } });
    expect(refund!.status).toBe('SUCCESS');
    expect(refund!.refundNo).toBe(`RF-${orderNo}`);
    expect(refund!.attempts.length).toBeGreaterThanOrEqual(1);

    // 收据作废（业主端）
    const receipt = await request(app.getHttpServer())
      .get(`/api/v1/owner/payments/${orderNo}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(receipt.body.data.receiptVoid).toBe(true);
  });

  it('相同 requestId 幂等重放，返回同一退款单', async () => {
    const orderNo = await seedPayment({ communityIds: [communityId] });
    const first = await request(app.getHttpServer())
      .post('/api/v1/admin/refunds').set('Authorization', `Bearer ${adminToken}`)
      .send({ orderNo, reason: 'x', requestId: `rq-${orderNo}` }).expect(200);
    const second = await request(app.getHttpServer())
      .post('/api/v1/admin/refunds').set('Authorization', `Bearer ${adminToken}`)
      .send({ orderNo, reason: 'x', requestId: `rq-${orderNo}` }).expect(200);
    expect(second.body.data.refundNo).toBe(first.body.data.refundNo);
    const refunds = await prisma.raw.refund.findMany({ where: { paymentOrderNo: orderNo } });
    expect(refunds.length).toBe(1);
  });

  it('微信明确拒绝时退款失败并恢复账单 PAID、订单仍 SUCCESS', async () => {
    const orderNo = await seedPayment({ communityIds: [communityId] });
    refundControl.mode = 'REJECT';
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/refunds').set('Authorization', `Bearer ${adminToken}`)
      .send({ orderNo, reason: 'x', requestId: `rq-${orderNo}` }).expect(200);
    expect(res.body.code).toBe(43005);

    const payment = await prisma.raw.payment.findUnique({ where: { orderNo } });
    expect(payment!.status).toBe('SUCCESS');
    const bills = await prisma.raw.bill.findMany({ where: { paymentId: payment!.id } });
    expect(bills.every((b) => b.status === 'PAID')).toBe(true);
    const refund = await prisma.raw.refund.findUnique({ where: { paymentId: payment!.id } });
    expect(refund!.status).toBe('FAILED');
  });

  it('历史跨小区多账单订单可整单退款（communityId 派生为 null）', async () => {
    const orderNo = await seedPayment({ communityIds: [communityId, community2Id] });
    const payment = await prisma.raw.payment.findUnique({ where: { orderNo } });
    expect(payment!.communityId).toBeNull();

    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/refunds').set('Authorization', `Bearer ${adminToken}`)
      .send({ orderNo, reason: 'x', requestId: `rq-${orderNo}` }).expect(200);
    expect(res.body.data.status).toBe('SUCCESS');
    const bills = await prisma.raw.bill.findMany({ where: { paymentId: payment!.id } });
    expect(bills.every((b) => b.status === 'REFUNDED')).toBe(true);
    const refund = await prisma.raw.refund.findUnique({ where: { paymentId: payment!.id } });
    expect(refund!.communityId).toBeNull();
  });

  it('退款恢复：PROCESSING 退款经查单转 SUCCESS', async () => {
    const orderNo = await seedPayment({ communityIds: [communityId] });
    refundControl.mode = 'PROCESSING';
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/refunds').set('Authorization', `Bearer ${adminToken}`)
      .send({ orderNo, reason: 'x', requestId: `rq-${orderNo}` }).expect(200);
    expect(res.body.data.status).toBe('PROCESSING');

    // 恢复查单裁决为成功
    refundControl.queryStatus = 'SUCCESS';
    const recovery = app.get(require('../src/payment/refund-recovery.service').RefundRecoveryService);
    const prevMode = process.env.PAY_MODE;
    process.env.PAY_MODE = 'wxpay';
    await recovery.recoverStaleRefunds(new Date(Date.now() + 10 * 60 * 1000));
    process.env.PAY_MODE = prevMode;

    const refund = await prisma.raw.refund.findFirst({ where: { paymentOrderNo: orderNo } });
    expect(refund!.status).toBe('SUCCESS');
    const payment = await prisma.raw.payment.findUnique({ where: { orderNo } });
    expect(payment!.status).toBe('REFUNDED');
  });
});
