import { Prisma } from '@prisma/client';
import { OwnerBillsService } from './owner-bills.controller';

/**
 * 账期小计必须由服务端算。
 *
 * 缺陷经过：小程序按 periodKey 给账单分组，组头显示「2026-05 · 5 笔 · ¥X」。
 * 而列表的排序是 `status asc, createdAt desc` —— **不按账期**，
 * 同一账期的账单会散落在不同分页里。于是组头那个数字只是「已加载页里这个账期的和」，
 * 却长着权威数字的样子。某户 30 条账单时，业主问「5 月欠多少」，读到的是偏小的错数。
 *
 * 同一份原则在首页大数字上已经落实过（summary 走权威接口），这里是当时漏掉的另一半。
 */
describe('业主账单按账期的权威小计', () => {
  const groupBy = jest.fn();
  const houses = { assertOwnerHouse: jest.fn().mockResolvedValue(undefined) };
  const prisma = { raw: { bill: { groupBy } } };
  const svc = new OwnerBillsService(prisma as never, houses as never);

  beforeEach(() => {
    groupBy.mockReset();
    houses.assertOwnerHouse.mockClear();
    groupBy.mockResolvedValue([
      { period: '2026-05', _count: { _all: 10 }, _sum: { amount: new Prisma.Decimal('1234.56') } },
      { period: '2026-07', _count: { _all: 3 }, _sum: { amount: new Prisma.Decimal('300.00') } },
    ]);
  });

  it('先校验房屋归属，再查数据', async () => {
    // 顺序反了就是「先算别人家的账单再拒绝」，数据已经离开数据库
    await svc.byPeriod('owner-1', { houseId: 'h1' } as never);
    expect(houses.assertOwnerHouse).toHaveBeenCalledWith('owner-1', 'h1');
  });

  it('账期倒序返回，与小程序分组顺序一致', async () => {
    // 两边各排一次就可能排得不一样；服务端排好，客户端直接用
    const rows = await svc.byPeriod('owner-1', { houseId: 'h1' } as never);
    expect(rows.map((r) => r.period)).toEqual(['2026-07', '2026-05']);
  });

  it('金额转成字符串（Decimal 直接序列化形状不稳）', async () => {
    const rows = await svc.byPeriod('owner-1', { houseId: 'h1' } as never);
    expect(rows[1]).toEqual({ period: '2026-05', count: 10, amount: '1234.56' });
    expect(typeof rows[1].amount).toBe('string');
  });

  it('过滤条件与列表完全一致——否则两处笔数对不上', async () => {
    /*
     * 「同一个量两处显示成两个数」比缺一个数字更难排查：用户会先怀疑自己看错，
     * 然后怀疑系统在乱算。本仓已经出过一次（收缴率两处不同），不能再来一次。
     */
    await svc.byPeriod('owner-1', { houseId: 'h1', status: 'UNPAID', ruleId: 'r9' } as never);
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['period'],
        where: { houseId: 'h1', status: 'UNPAID', ruleId: 'r9' },
      }),
    );
  });

  it('不传 status 时排除草稿账单（与列表一致）', async () => {
    // 草稿账单对业主不可见。若这里不排除，组头笔数会比列表多，且多出的是不该看到的
    await svc.byPeriod('owner-1', { houseId: 'h1' } as never);
    const where = groupBy.mock.calls[0][0].where;
    expect(where.status).toEqual({ not: 'DRAFT' });
  });

  it('传 DRAFT 也不放行（业主不能通过参数看到草稿）', async () => {
    await svc.byPeriod('owner-1', { houseId: 'h1', status: 'DRAFT' } as never);
    expect(groupBy.mock.calls[0][0].where.status).toEqual({ not: 'DRAFT' });
  });

  it('某账期合计为 null 时按 0 处理而不是崩掉', async () => {
    // groupBy 的 _sum 在无匹配行时是 null
    groupBy.mockResolvedValue([{ period: '2026-06', _count: { _all: 0 }, _sum: { amount: null } }]);
    const rows = await svc.byPeriod('owner-1', { houseId: 'h1' } as never);
    expect(rows[0].amount).toBe('0');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 路由必须真的注册，且不被 @Get(':id') 吃掉
// ────────────────────────────────────────────────────────────────────────────

/**
 * 单测直接调 service 完全绕过路由注册。而 by-period 是个静态路径，
 * 与同控制器里的 @Get(':id') 形状冲突 —— 若被后者吃掉，
 * 线上会拿「by-period」当账单 ID 去查，返回 40400，
 * 而 40400 同时是「端点不存在」与「账单不存在」，无从区分（本仓为此白花过十几分钟）。
 *
 * 断言写成「两个端点不互相抢请求」而不是「声明顺序」——但要说清楚为什么：
 *
 * Express 按声明顺序匹配，所以顺序**在两条路由能匹配同一个 URL 时**确实要紧。
 * 我验证过：把 @Get('by-period') 移到 @Get(':id') 之后，这里的断言就会失败，
 * 请求被详情处理器吃掉。
 *
 * 本仓早前删过一条「路由顺序」测试，当时的结论写成了「顺序不是匹配规则」——
 * **那是过度概括**。真实规则是「段数相同、都能匹配时才有冲突」：
 * 被删那条比的是 4 段路径与 :id（1 段），:id 根本匹配不到 4 段 URL，
 * 所以那次顺序确实无关，删得对，但理由写错了。
 * 这里是 1 段对 1 段，顺序有关。
 *
 * 断言仍然写成「不互相抢请求」而不是「谁先声明」：前者是真正要保证的行为，
 * 后者只是实现手段之一，钉手段的测试会在无害重构下误报。
 */
describe('by-period 的路由注册', () => {
  it('打 by-period 走聚合，不走详情', async () => {
    const { Test } = await import('@nestjs/testing');
    const request = (await import('supertest')).default;
    const { OwnerBillsController } = await import('./owner-bills.controller');
    const { OwnerGuard } = await import('../auth/owner.guard');

    const service = {
      byPeriod: jest.fn().mockResolvedValue([{ period: '2026-07', count: 1, amount: '1.00' }]),
      detail: jest.fn().mockResolvedValue({ id: 'x' }),
      list: jest.fn(),
      summary: jest.fn(),
      filters: jest.fn(),
    };
    const mod = await Test.createTestingModule({
      controllers: [OwnerBillsController],
      providers: [{ provide: (await import('./owner-bills.controller')).OwnerBillsService, useValue: service }],
    })
      .overrideGuard(OwnerGuard)
      .useValue({ canActivate: (ctx: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }) => {
        ctx.switchToHttp().getRequest().current = { ownerId: 'o1' };
        return true;
      } })
      .compile();
    const app = mod.createNestApplication();
    await app.init();
    try {
      const res = await request(app.getHttpServer()).get('/owner/bills/by-period?houseId=h1');
      expect(res.status).toBe(200);
      expect(service.byPeriod).toHaveBeenCalled();
      // 关键：详情处理器不得被触发
      expect(service.detail).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('打具体 ID 走详情，不走聚合', async () => {
    const { Test } = await import('@nestjs/testing');
    const request = (await import('supertest')).default;
    const { OwnerBillsController, OwnerBillsService } = await import('./owner-bills.controller');
    const { OwnerGuard } = await import('../auth/owner.guard');
    const service = {
      byPeriod: jest.fn(),
      detail: jest.fn().mockResolvedValue({ id: 'bill-1' }),
      list: jest.fn(),
      summary: jest.fn(),
      filters: jest.fn(),
    };
    const mod = await Test.createTestingModule({
      controllers: [OwnerBillsController],
      providers: [{ provide: OwnerBillsService, useValue: service }],
    })
      .overrideGuard(OwnerGuard)
      .useValue({ canActivate: (ctx: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }) => {
        ctx.switchToHttp().getRequest().current = { ownerId: 'o1' };
        return true;
      } })
      .compile();
    const app = mod.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer()).get('/owner/bills/bill-1');
      expect(service.detail).toHaveBeenCalledWith('o1', 'bill-1');
      expect(service.byPeriod).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
