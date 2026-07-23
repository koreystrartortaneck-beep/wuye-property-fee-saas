import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

function execSql(sql: string): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('bill-run E2E requires DATABASE_URL');
  const prismaCli = require.resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'db', 'execute', '--stdin', '--url', url], {
    cwd: join(__dirname, '..'), input: sql, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url }, timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`execSql failed:\n${[result.stdout, result.stderr].filter(Boolean).join('\n')}`);
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

describe('账单草稿：出账 / 发布 / 作废 / 重开 / 导入', () => {
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
      await prisma.raw.reconciliationItem.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.refundAttempt.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.paymentEvent.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.invoiceApplication.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.refund.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.paymentBill.deleteMany({ where: { payment: { tenantId: t.id } } });
      await prisma.raw.payment.deleteMany({ where: { tenantId: t.id } });
      // 先解除账单自引用（重开 replacesBillId），再批量删除，避免自引用 FK 阻塞。
      await prisma.raw.bill.updateMany({ where: { tenantId: t.id, replacesBillId: { not: null } }, data: { replacesBillId: null } });
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
    await prisma.raw.house.create({ data: { tenantId, communityId, code: 'r-101', displayName: '101', area: 100 } });
    await prisma.raw.house.create({ data: { tenantId, communityId, code: 'r-102', displayName: '102', area: 50 } });
    const noArea = await prisma.raw.house.create({ data: { tenantId, communityId, code: 'r-103', displayName: '103', area: null } });
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

  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  const trigger = (ruleId: string, period: string) =>
    auth(request(app.getHttpServer()).post('/api/v1/admin/bill-runs')).send({ ruleId, period });
  const publish = (batchId: string, requestId: string) =>
    auth(request(app.getHttpServer()).post(`/api/v1/admin/bill-batches/${batchId}/publish`)).send({ requestId });

  let areaBatchId: string;

  it('AREA_PRICE 出账生成 DRAFT 批次：generated 2, skipped 1，账单为 DRAFT', async () => {
    const res = await trigger(areaRuleId, '2026-07').expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({ status: 'DRAFT', generated: 2, skipped: 1 });
    areaBatchId = res.body.data.batchId;

    const bills = await prisma.raw.bill.findMany({ where: { ruleId: areaRuleId, period: '2026-07' } });
    expect(bills).toHaveLength(2);
    expect(bills.every((b) => b.status === 'DRAFT' && b.batchId === areaBatchId)).toBe(true);
    const amounts = bills.map((b) => Number(b.amount)).sort((a, b) => a - b);
    expect(amounts).toEqual([100, 200]);
  });

  it('重跑：generated 0（幂等，进入同一草稿批次）', async () => {
    const res = await trigger(areaRuleId, '2026-07').expect(200);
    expect(res.body.data.generated).toBe(0);
    expect(res.body.data.batchId).toBe(areaBatchId);
  });

  it('补面积后重跑：只补缺的 1 张', async () => {
    await prisma.raw.house.update({ where: { id: houseNoAreaId }, data: { area: 80 } });
    const res = await trigger(areaRuleId, '2026-07').expect(200);
    expect(res.body.data.generated).toBe(1);
    const count = await prisma.raw.bill.count({ where: { ruleId: areaRuleId, period: '2026-07' } });
    expect(count).toBe(3);
  });

  it('草稿对统计不可见', async () => {
    const res = await auth(request(app.getHttpServer()).get(`/api/v1/admin/stats/summary?communityId=${communityId}&period=2026-07`)).expect(200);
    expect(res.body.data.billCount).toBe(0);
  });

  it('发布草稿批次：账单转 UNPAID，写审计与 Outbox', async () => {
    const res = await publish(areaBatchId, 'pub-area-1').expect(200);
    expect(res.body.data).toMatchObject({ status: 'PUBLISHED', publishedCount: 3 });
    const bills = await prisma.raw.bill.findMany({ where: { batchId: areaBatchId } });
    expect(bills.every((b) => b.status === 'UNPAID' && b.publishedAt)).toBe(true);
    const audit = await prisma.raw.auditLog.findFirst({ where: { tenantId, action: 'PUBLISH', resourceType: 'BillBatch', resourceId: areaBatchId } });
    expect(audit).toBeTruthy();
    const outbox = await prisma.raw.outboxEvent.findMany({ where: { tenantId, eventType: 'bill.published' } });
    expect(outbox.length).toBe(3);
  });

  it('发布幂等：重复发布返回同一结果', async () => {
    const res = await publish(areaBatchId, 'pub-area-1').expect(200);
    expect(res.body.data.status).toBe('PUBLISHED');
  });

  it('发布后统计可见', async () => {
    const res = await auth(request(app.getHttpServer()).get(`/api/v1/admin/stats/summary?communityId=${communityId}&period=2026-07`)).expect(200);
    expect(res.body.data.billCount).toBe(3);
  });

  it('SHARE：缺公摊总额 → 批次 FAILED', async () => {
    const res = await trigger(shareRuleId, '2026-07').expect(200);
    expect(res.body.data.status).toBe('FAILED');
    expect(res.body.data.generated).toBe(0);
  });

  it('补公摊总额后重跑：DONE 且分摊守恒，随后发布', async () => {
    await prisma.raw.sharePool.create({ data: { tenantId, ruleId: shareRuleId, period: '2026-07', totalAmount: 100.01 } });
    const res = await trigger(shareRuleId, '2026-07').expect(200);
    expect(res.body.data.generated).toBe(3);
    const bills = await prisma.raw.bill.findMany({ where: { ruleId: shareRuleId, period: '2026-07' } });
    const sumCents = bills.reduce((s, b) => s + Math.round(Number(b.amount) * 100), 0);
    expect(sumCents).toBe(10001);
    await publish(res.body.data.batchId, 'pub-share-1').expect(200);
  });

  let cancelBillId: string;

  it('作废已发布未缴账单：需原因，写审计；重复作废报错', async () => {
    const bill = await prisma.raw.bill.findFirst({ where: { ruleId: areaRuleId, period: '2026-07', status: 'UNPAID' } });
    cancelBillId = bill!.id;
    const res = await auth(request(app.getHttpServer()).post(`/api/v1/admin/bills/${cancelBillId}/cancel`))
      .send({ reason: '录入错误', requestId: 'cancel-1' })
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.status).toBe('CANCELED');
    const audit = await prisma.raw.auditLog.findFirst({ where: { tenantId, action: 'CANCEL', resourceType: 'Bill', resourceId: cancelBillId } });
    expect(audit).toBeTruthy();

    const again = await auth(request(app.getHttpServer()).post(`/api/v1/admin/bills/${cancelBillId}/cancel`))
      .send({ reason: 'x', requestId: 'cancel-2' })
      .expect(200);
    expect(again.body.code).not.toBe(0);
  });

  it('缺原因作废被拒', async () => {
    const bill = await prisma.raw.bill.findFirst({ where: { ruleId: areaRuleId, period: '2026-07', status: 'UNPAID' } });
    const res = await auth(request(app.getHttpServer()).post(`/api/v1/admin/bills/${bill!.id}/cancel`))
      .send({ requestId: 'cancel-3' })
      .expect(200);
    expect(res.body.code).toBe(40000);
  });

  it('重开作废账单：新账单链接原账单', async () => {
    const res = await auth(request(app.getHttpServer()).post(`/api/v1/admin/bills/${cancelBillId}/reissue`))
      .send({ reason: '重新出账', requestId: 'reissue-1' })
      .expect(200);
    expect(res.body.data).toMatchObject({ replacesBillId: cancelBillId, status: 'UNPAID' });
    const created = await prisma.raw.bill.findUnique({ where: { id: res.body.data.billId } });
    expect(created?.replacesBillId).toBe(cancelBillId);
    expect(created?.status).toBe('UNPAID');
  });

  it('CSV 导入预览与确认：非法行报告、有效行落草稿并可发布', async () => {
    const csv = 'houseCode,amount,title\nr-101,66.00,车位费\nr-999,66.00,车位费\nr-102,-1,车位费\n';
    const preview = await auth(request(app.getHttpServer()).post('/api/v1/admin/bill-imports/preview'))
      .field('communityId', communityId)
      .field('period', '2026-09')
      .field('title', '车位费')
      .attach('file', Buffer.from(csv), 'bills.csv')
      .expect(200);
    expect(preview.body.data.summary).toMatchObject({ total: 3, valid: 1, invalid: 2 });

    const confirm = await auth(request(app.getHttpServer()).post('/api/v1/admin/bill-imports/confirm'))
      .field('communityId', communityId)
      .field('period', '2026-09')
      .field('title', '车位费')
      .attach('file', Buffer.from(csv), 'bills.csv')
      .expect(200);
    expect(confirm.body.data).toMatchObject({ status: 'DRAFT' });
    const batchId = confirm.body.data.batchId;
    const drafts = await prisma.raw.bill.findMany({ where: { batchId } });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe('DRAFT');
    expect(drafts[0].source).toBe('IMPORT');

    // 同文件重复确认：文件哈希幂等，复用同一批次。
    const again = await auth(request(app.getHttpServer()).post('/api/v1/admin/bill-imports/confirm'))
      .field('communityId', communityId)
      .field('period', '2026-09')
      .field('title', '车位费')
      .attach('file', Buffer.from(csv), 'bills.csv')
      .expect(200);
    expect(again.body.data.batchId).toBe(batchId);

    await publish(batchId, 'pub-import-1').expect(200);
    const published = await prisma.raw.bill.findMany({ where: { batchId } });
    expect(published.every((b) => b.status === 'UNPAID')).toBe(true);
  });

  it('后台账单查询', async () => {
    const res = await auth(request(app.getHttpServer()).get(`/api/v1/admin/bills?communityId=${communityId}&period=2026-07`)).expect(200);
    expect(res.body.data.total).toBeGreaterThanOrEqual(6);
  });

  it('FORMULA 规则拒绝出账', async () => {
    const formula = await prisma.raw.feeRule.create({
      data: { tenantId, communityId, name: '公式', houseType: 'RESIDENCE', ruleType: 'FORMULA', params: { expr: 'area*2' }, period: 'MONTHLY', billDay: 1, dueDays: 15 },
    });
    const res = await trigger(formula.id, '2026-07').expect(200);
    expect(res.body.code).toBe(42005);
  });

  it('旧式账单写入无需批次、发布、作废或替代字段且仍可读', async () => {
    const run = await prisma.raw.billRun.create({ data: { tenantId, ruleId: areaRuleId, period: '2026-08', status: 'DONE' } });
    const created = await prisma.raw.bill.create({
      data: {
        tenantId, communityId, houseId: houseNoAreaId, ruleId: areaRuleId, billRunId: run.id, period: '2026-08',
        title: '旧式物业费 2026-08', snapshot: { unitPrice: 2, area: 80 }, amount: '160.00', dueDate: new Date('2026-08-15T00:00:00.000Z'),
      },
    });
    const found = await prisma.raw.bill.findUnique({ where: { id: created.id }, include: { rule: true, billRun: true, paymentBills: true } });
    expect(found).toMatchObject({ title: '旧式物业费 2026-08', ruleId: areaRuleId, billRunId: run.id, batchId: null, source: null });
    expect(found?.paymentBills).toEqual([]);
  });
});
