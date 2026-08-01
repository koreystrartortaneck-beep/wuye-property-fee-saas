import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './test-app';

/**
 * 支付回调被拒必须留下痕迹。
 *
 * 真实事故：业主付了钱，订单卡在 CREATED。我要判断「微信回调没来」还是
 * 「回调来了但验签失败」—— 结果两种情况在系统里长得一模一样：
 * 我拿垃圾数据打了两次回调接口，都返回 401，而运维事件一条都没有。
 *
 * 没有痕迹就没法定位：验签失败通常意味着平台证书配错，那是要立刻处理的；
 * 而回调没来意味着商户平台的回调地址配错。两者的修法完全不同。
 */
describe('支付回调验签失败留痕', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const TENANT = 'cbk-alert-t1';

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    const t = await prisma.raw.tenant.upsert({
      where: { code: TENANT },
      update: {},
      create: { name: '回调告警测试', code: TENANT },
    });
    // 回调没有租户上下文，归属靠这个环境变量
    process.env.WX_PAY_ALLOWED_TENANT_ID = t.id;
    await prisma.raw.operationalAlert.deleteMany({ where: { tenantId: t.id } });
    await prisma.raw.incident.deleteMany({ where: { tenantId: t.id } });
  });

  afterAll(async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: TENANT } });
    if (t) {
      await prisma.raw.alertAttempt.deleteMany({ where: { alert: { tenantId: t.id } } });
      await prisma.raw.operationalAlert.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.incident.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
    await app?.close();
  });

  it('验签失败返回 401，并写入一条 CRITICAL 告警', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/payment/wxpay/notify')
      .set('Content-Type', 'application/json')
      .send({ probe: 'bad-signature' });
    expect(res.status).toBe(401);

    const tenantId = process.env.WX_PAY_ALLOWED_TENANT_ID!;
    const alerts = await prisma.raw.operationalAlert.findMany({ where: { tenantId } });
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].alertType).toBe('PAYMENT_CALLBACK_REJECTED');
    expect(alerts[0].severity).toBe('CRITICAL');
  });
});
