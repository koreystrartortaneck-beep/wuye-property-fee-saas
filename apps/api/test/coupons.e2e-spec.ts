import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('卡券：物业发券 → 领取 → 核销', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let communityId: string;
  let houseId: string;
  let ownerToken: string;
  let adminToken: string;
  let couponId: string;
  let claimCode: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'cpn-p4' } });
    if (t) {
      await prisma.raw.userCoupon.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.coupon.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.houseBinding.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.adminUser.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'cpn-p4-owner' } });
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await CLEAN();
    const tenant = await prisma.raw.tenant.create({ data: { name: '卡券测试', code: 'cpn-p4' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'cpn-p4-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    communityId = (await prisma.raw.community.create({ data: { tenantId, name: '卡券小区' } })).id;
    houseId = (await prisma.raw.house.create({ data: { tenantId, communityId, code: 'p-101', displayName: 'p101', area: 100 } })).id;

    const wx = await request(app.getHttpServer()).post('/api/v1/auth/wx-login').send({ code: 'mock:cpn-p4-owner' });
    ownerToken = wx.body.data.token;
    const user = await prisma.raw.wxUser.findUnique({ where: { openid: 'cpn-p4-owner' } });
    await prisma.raw.houseBinding.create({ data: { tenantId, wxUserId: user!.id, houseId, status: 'ACTIVE', source: 'PHONE_MATCH' } });
    const login = await request(app.getHttpServer()).post('/api/v1/admin/auth/login').send({ username: 'cpn-p4-adm', password: 'p123456' });
    adminToken = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  it('管理端发券（物业费满100减10，限领1张，总量2）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ communityId, name: '物业费满100减10', type: 'DISCOUNT', faceValue: 10, threshold: 100, totalQty: 2, perUserLimit: 1, validFrom: '2026-01-01', validTo: '2026-12-31' })
      .expect(200);
    expect(res.body.code).toBe(0);
    couponId = res.body.data.id;
  });

  it('业主看到可领券，剩余 2', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/owner/coupons?houseId=${houseId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].remaining).toBe(2);
  });

  it('领取生成核销码', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/owner/coupons/${couponId}/claim`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.code).toMatch(/^[A-Z0-9]{8}$/);
    claimCode = res.body.data.code;
  });

  it('超过每人限领数被拒 45004', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/owner/coupons/${couponId}/claim`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.code).toBe(45004);
  });

  it('我的卡券含该券', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/owner/my/coupons')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.list[0].status).toBe('UNUSED');
    expect(res.body.data.list[0].coupon.name).toBe('物业费满100减10');
  });

  it('并发领取不会超发——靠数据库唯一约束，不是靠应用层 count', async () => {
    /*
     * 这条对着真 MySQL 验的是数据库级保证，不是 mock。
     *
     * 原实现在事务外 count 一次再进事务（TOCTOU）：同一用户并发两次领取都读到 0、
     * 都通过校验，各自建一条记录 —— 领到超额的券，而每张券都是实打实的抵扣金额。
     * 修法是 UserCoupon 上加 @@unique([couponId, wxUserId, claimSeq])，
     * 并发时必有一方撞 P2002。
     *
     * 单元测试里那个「唯一约束」是我用 Set 模拟的，只能证明代码逻辑；
     * 这里用真数据库 + 真并发，才能证明约束本身在生产的 MySQL 上生效。
     */
    const fresh = await request(app.getHttpServer())
      .post('/api/v1/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        communityId, name: '并发测试券', type: 'DISCOUNT', faceValue: 5, threshold: 10,
        totalQty: 50, perUserLimit: 1, validFrom: '2026-01-01', validTo: '2026-12-31',
      })
      .expect(200);
    const cid = fresh.body.data.id;

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app.getHttpServer())
          .post(`/api/v1/owner/coupons/${cid}/claim`)
          .set('Authorization', `Bearer ${ownerToken}`),
      ),
    );
    const ok = results.filter((r) => r.body.code === 0);
    const limited = results.filter((r) => r.body.code === 45004);

    // perUserLimit = 1：只能有一次成功，其余必须是「已达上限」
    expect(ok).toHaveLength(1);
    expect(limited).toHaveLength(5);

    // 库里也只能有一条，且库存只被扣了一次
    const rows = await prisma.raw.userCoupon.count({ where: { couponId: cid } });
    expect(rows).toBe(1);
    const coupon = await prisma.raw.coupon.findUnique({ where: { id: cid } });
    expect(coupon!.claimedQty).toBe(1);
  });

  it('并发核销只有一次成功——两个收银台同时扫同一张券', async () => {
    /*
     * 原实现是「findFirst 查到 UNUSED → 无条件 update」：两个收银台同时扫，
     * 两边都查到 UNUSED、两次 update 都成功，礼品券被兑两份。
     * 修法是条件 updateMany + count 校验（与支付侧的券消费同一形状）。
     *
     * 顺序调用两次是查不出这个问题的（第一次已把状态改掉），必须真并发。
     */
    const fresh = await request(app.getHttpServer())
      .post('/api/v1/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        communityId, name: '并发核销券', type: 'SERVICE', totalQty: 5, perUserLimit: 1,
        validFrom: '2026-01-01', validTo: '2026-12-31',
      })
      .expect(200);
    const claim = await request(app.getHttpServer())
      .post(`/api/v1/owner/coupons/${fresh.body.data.id}/claim`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const code = claim.body.data.code;

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app.getHttpServer())
          .post(`/api/v1/admin/coupons/verify/${code}`)
          .set('Authorization', `Bearer ${adminToken}`),
      ),
    );
    expect(results.filter((r) => r.body.code === 0)).toHaveLength(1);
    expect(results.filter((r) => r.body.code === 45005)).toHaveLength(3);
  });

  it('管理端核销 → 重复核销被拒', async () => {
    const v = await request(app.getHttpServer())
      .post(`/api/v1/admin/coupons/verify/${claimCode}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(v.body.data.status).toBe('USED');
    const again = await request(app.getHttpServer())
      .post(`/api/v1/admin/coupons/verify/${claimCode}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(again.body.code).toBe(45005);
  });
});
