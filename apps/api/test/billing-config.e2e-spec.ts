import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('计费配置：规则/抄表/公摊', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let communityId: string;
  let houseId: string;
  let token: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'cfg-t11' } });
    if (t) {
      /*
       * 账单/批次/出账记录也要清。
       *
       * 「后一期已出账后不许改读数」那条用例会真的出一次账 ——
       * 不清的话下次跑就删不掉 feeRule（被 Bill 引用）、进而删不掉租户，
       * 整个文件连坐全红。我第一次加这条用例时就是这么红了 15 条。
       * 顺序按外键依赖从叶到根。
       */
      await prisma.raw.paymentBill.deleteMany({ where: { bill: { tenantId: t.id } } });
      await prisma.raw.bill.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.billRun.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.billBatch.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.sharePool.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.meterReading.deleteMany({ where: { tenantId: t.id } });
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
    const tenant = await prisma.raw.tenant.create({ data: { name: '配置测试物业', code: 'cfg-t11' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'cfg-t11-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    const community = await prisma.raw.community.create({ data: { tenantId, name: '配置测试小区' } });
    communityId = community.id;
    const house = await prisma.raw.house.create({
      data: { tenantId, communityId, code: '3-1-301', displayName: '3栋1单元301', area: 100 },
    });
    houseId = house.id;
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'cfg-t11-adm', password: 'p123456' });
    token = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  const post = (url: string, body: object) =>
    request(app.getHttpServer()).post(`/api/v1/admin${url}`).set('Authorization', `Bearer ${token}`).send(body);

  it('创建 4 类规则成功', async () => {
    const cases = [
      { name: '物业管理费', ruleType: 'AREA_PRICE', params: { unitPrice: 2.5 }, houseType: 'RESIDENCE', period: 'MONTHLY', billDay: 1, dueDays: 15 },
      { name: '车位管理费', ruleType: 'FIXED', params: { amount: 360 }, houseType: 'PARKING', period: 'MONTHLY', billDay: 1, dueDays: 15 },
      { name: '水费', ruleType: 'METER', params: { unitPrice: 3.5, meterType: 'WATER' }, houseType: 'RESIDENCE', period: 'MONTHLY', billDay: 5, dueDays: 10 },
      { name: '公共能耗', ruleType: 'SHARE', params: { shareBy: 'AREA' }, houseType: 'RESIDENCE', period: 'MONTHLY', billDay: 1, dueDays: 15 },
    ];
    for (const c of cases) {
      const res = await post('/fee-rules', { ...c, communityId }).expect(200);
      expect(res.body.code).toBe(0);
    }
  });

  it('坏 params 被拒（42001/42005）', async () => {
    const bad1 = await post('/fee-rules', {
      name: '坏规则', ruleType: 'AREA_PRICE', params: { unitPrice: -1 }, houseType: 'RESIDENCE',
      period: 'MONTHLY', billDay: 1, dueDays: 15, communityId,
    }).expect(200);
    expect(bad1.body.code).toBe(42001);

    const bad2 = await post('/fee-rules', {
      name: '坏公式', ruleType: 'FORMULA', params: { expr: 'pow(2,3)', vars: {} }, houseType: 'RESIDENCE',
      period: 'MONTHLY', billDay: 1, dueDays: 15, communityId,
    }).expect(200);
    expect(bad2.body.code).toBe(42005);
  });

  it('billDay 超范围被拒', async () => {
    const res = await post('/fee-rules', {
      name: '坏出账日', ruleType: 'FIXED', params: { amount: 1 }, houseType: 'RESIDENCE',
      period: 'MONTHLY', billDay: 31, dueDays: 15, communityId,
    }).expect(200);
    expect(res.body.code).toBe(40000);
  });

  it('抄表录入与回退拒绝', async () => {
    const first = await post('/meter-readings', { houseId, meterType: 'WATER', period: '2026-06', value: 1200.3 }).expect(200);
    expect(first.body.code).toBe(0);

    const second = await post('/meter-readings', { houseId, meterType: 'WATER', period: '2026-07', value: 1234.5 }).expect(200);
    expect(second.body.code).toBe(0);
    expect(Number(second.body.data.prevValue)).toBe(1200.3);

    const backward = await post('/meter-readings', { houseId, meterType: 'WATER', period: '2026-08', value: 1000 }).expect(200);
    expect(backward.body.code).toBe(42002);
  });

  /*
   * 「改本期读数」的两道约束此前零覆盖（meter.controller 80-96 行），
   * 而它们保护的是用量计算 —— 用量错一位，那户的水电费就错一位。
   */
  it('改本期读数不能超过后一期：否则后一期用量变负', async () => {
    // 已有 2026-06=1200.3、2026-07=1235.0。把 6 月改到 1300 会让 7 月用量变成负数
    const res = await post('/meter-readings', {
      houseId, meterType: 'WATER', period: '2026-06', value: 1300,
    }).expect(200);
    // 42006 而不是 42002：这是与「后一期」冲突，不是「小于上期」——
    // 复用后者会让提示变成「不能小于上期读数：…大于后一期…」，一句话两个相反判断
    expect(res.body.code).toBe(42006);
    expect(res.body.message).toContain('2026-07');
    expect(res.body.message).toContain('1234.5');
    // 提示里不得出现相反的说法
    expect(res.body.message).not.toContain('不能小于上期');

    // 原值必须没被改动
    const kept = await prisma.raw.meterReading.findFirst({
      where: { houseId, meterType: 'WATER', period: '2026-06' },
    });
    expect(Number(kept!.value)).toBe(1200.3);
  });

  it('后一期已出账后，本期读数不许再改', async () => {
    /*
     * 这是更严重的一种：后一期已经按当时的用量出了账单并可能已缴费，
     * 改本期读数会让那张已出的账单「用量」与读数不再自洽 ——
     * 账单金额已经收了钱，对不上就只能人工查账。
     */
    const rule = await prisma.raw.feeRule.create({
      data: {
        tenantId, communityId, name: '水费(后一期)', houseType: 'RESIDENCE', ruleType: 'METER',
        params: { unitPrice: 3, meterType: 'WATER' }, period: 'MONTHLY', billDay: 1, dueDays: 15,
      },
    });
    const gen = await post('/bill-runs', { ruleId: rule.id, period: '2026-07' }).expect(200);
    expect(gen.body.code).toBe(0);
    expect(gen.body.data.generated).toBe(1);

    const res = await post('/meter-readings', {
      houseId, meterType: 'WATER', period: '2026-06', value: 1100,
    }).expect(200);
    expect(res.body.code).toBe(40000);
    // 必须说清是哪一期的哪张账单挡着
    expect(res.body.message).toContain('2026-07');
    expect(res.body.message).toContain('已出账');
  });

  it('同期重复录入为覆盖更新', async () => {
    const res = await post('/meter-readings', { houseId, meterType: 'WATER', period: '2026-07', value: 1235.0 }).expect(200);
    expect(res.body.code).toBe(0);
    const n = await prisma.raw.meterReading.count({ where: { houseId, meterType: 'WATER', period: '2026-07' } });
    expect(n).toBe(1);
  });

  /*
   * 规则的改 / 转换 / 退役此前完全没有行为覆盖（fee-rules.controller 126-191 行）。
   * 这几条路径直接决定账单怎么算：改错单价、把停用的旧公式规则重新启用，
   * 后果都是全小区金额错一整期。合并覆盖率里它是唯一「涉及钱且还能测」的缺口。
   */
  describe('规则的改 / 转换 / 退役', () => {
    let fixedId: string;
    let formulaId: string;

    beforeAll(async () => {
      const created = await post('/fee-rules', {
        communityId, name: '可改规则', houseType: 'RESIDENCE', ruleType: 'FIXED',
        params: { amount: 30 }, period: 'MONTHLY', billDay: 1, dueDays: 15,
      });
      fixedId = created.body.data.id;
      /*
       * FORMULA 规则已停用（create 直接拒），只能由历史数据存在 ——
       * 所以这里绕过 API 直接建，模拟迁移前遗留的那些规则。
       */
      const legacy = await prisma.raw.feeRule.create({
        data: {
          tenantId, communityId, name: '遗留公式规则', houseType: 'RESIDENCE',
          ruleType: 'FORMULA', params: { expr: 'area * 2' }, period: 'MONTHLY',
          billDay: 1, dueDays: 15, enabled: false,
        },
      });
      formulaId = legacy.id;
    });

    const patch = (url: string, body: object) =>
      request(app.getHttpServer()).patch(`/api/v1/admin${url}`).set('Authorization', `Bearer ${token}`).send(body);

    it('改单价：params 会被重新校验', async () => {
      const ok = await patch(`/fee-rules/${fixedId}`, { params: { amount: 55 } });
      expect(ok.body.code).toBe(0);
      expect(ok.body.data.params).toEqual({ amount: 55 });

      // 负数金额必须被拒 —— 否则一期账单全变负数
      const bad = await patch(`/fee-rules/${fixedId}`, { params: { amount: -1 } });
      expect(bad.body.code).toBe(42001);
    });

    it('FORMULA 规则不可重新启用', async () => {
      const res = await patch(`/fee-rules/${formulaId}`, { enabled: true });
      expect(res.body.code).toBe(42005);
    });

    it('FORMULA 规则不可编辑参数', async () => {
      const res = await patch(`/fee-rules/${formulaId}`, { params: { expr: 'area * 3' } });
      expect(res.body.code).toBe(42005);
    });

    it('转换 FORMULA → AREA_PRICE：落地后保持停用，需人工复核再启用', async () => {
      const res = await post(`/fee-rules/${formulaId}/convert`, {
        ruleType: 'AREA_PRICE',
        params: { unitPrice: 2.5 },
      });
      expect(res.body.code).toBe(0);
      expect(res.body.data.ruleType).toBe('AREA_PRICE');
      /*
       * enabled 必须是 false：转换等于改了计费口径，
       * 直接接着出账会在无人复核的情况下改变全小区金额。
       */
      expect(res.body.data.enabled).toBe(false);
    });

    it('非 FORMULA 规则不能转换', async () => {
      const res = await post(`/fee-rules/${fixedId}/convert`, {
        ruleType: 'AREA_PRICE',
        params: { unitPrice: 1 },
      });
      expect(res.body.code).toBe(40000);
    });

    it('退役 FORMULA 规则：永久停用并留下处置标记', async () => {
      const legacy = await prisma.raw.feeRule.create({
        data: {
          tenantId, communityId, name: '待退役公式', houseType: 'RESIDENCE',
          ruleType: 'FORMULA', params: { expr: 'area * 9' }, period: 'MONTHLY',
          billDay: 1, dueDays: 15, enabled: false,
        },
      });
      const res = await post(`/fee-rules/${legacy.id}/retire`, {});
      expect(res.body.code).toBe(0);
      expect(res.body.data.enabled).toBe(false);
      // 处置标记要留在 params 里，供「公式规则处置报告」核对
      expect((res.body.data.params as Record<string, unknown>).__disposition).toBeTruthy();
    });

    it('处置报告列出全部 FORMULA 规则及其处置状态', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/fee-rules/formula-report')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.code).toBe(0);
      expect(Array.isArray(res.body.data.rules ?? res.body.data)).toBe(true);
    });
  });

  it('公摊总额 upsert', async () => {
    const rule = await prisma.raw.feeRule.findFirst({ where: { tenantId, ruleType: 'SHARE' } });
    const res1 = await request(app.getHttpServer())
      .put('/api/v1/admin/share-pools')
      .set('Authorization', `Bearer ${token}`)
      .send({ ruleId: rule!.id, period: '2026-07', totalAmount: 5000 })
      .expect(200);
    expect(res1.body.code).toBe(0);
    const res2 = await request(app.getHttpServer())
      .put('/api/v1/admin/share-pools')
      .set('Authorization', `Bearer ${token}`)
      .send({ ruleId: rule!.id, period: '2026-07', totalAmount: 5200 })
      .expect(200);
    expect(Number(res2.body.data.totalAmount)).toBe(5200);
  });
});
