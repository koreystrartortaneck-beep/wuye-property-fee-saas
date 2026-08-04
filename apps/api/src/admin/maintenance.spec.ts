import { MaintenanceService } from './maintenance.controller';
import { BizException } from '../common/biz.exception';

/**
 * 彻底清除(物理删除)。
 *
 * 这是系统里唯一能突破「审计不可删」的地方,所以每一道闸都必须钉住:
 *   · 名字打错 → 不删
 *   · 小区名下还有业务数据 → 不删(不代劳删房)
 *   · 要连审计一起销毁 → 必须显式开开关
 *   · 先写审计再动手,且审计行挂 communityId=null(否则它自己被这次清除带走)
 *   · 摘掉的触发器必须装回,装不回要炸(而不是静默留一张可改可删的审计表)
 */

const HOUSE = { id: 'h1', code: 'T-001', displayName: '测试房 001', tenantId: 't1', communityId: 'c1' };
const COMMUNITY = { id: 'c1', name: '【体验数据】云顶花园', tenantId: 't1', status: 'DISABLED' };

function makePrisma(opts: {
  house?: Record<string, unknown> | null;
  community?: Record<string, unknown> | null;
  counts?: Record<string, number>;
  auditCount?: number;
  triggersBack?: string[];
}) {
  const executed: string[] = [];
  const zero = { count: 0 };
  const delMany = jest.fn(async () => zero);
  const table = (): Record<string, jest.Mock> => ({ deleteMany: delMany, findMany: jest.fn(async () => []), count: jest.fn(async () => 0), updateMany: jest.fn(async () => zero) });
  const t: Record<string, Record<string, jest.Mock>> = {
    house: {
      findFirst: jest.fn(async () => (opts.house === undefined ? HOUSE : opts.house)),
      delete: jest.fn(async () => ({})),
      count: jest.fn(async () => opts.counts?.house ?? 0),
    } as unknown as Record<string, jest.Mock>,
    community: {
      findFirst: jest.fn(async () => (opts.community === undefined ? COMMUNITY : opts.community)),
      delete: jest.fn(async () => ({})),
    } as unknown as Record<string, jest.Mock>,
    bill: { ...table(), findMany: jest.fn(async () => []), count: jest.fn(async () => opts.counts?.bill ?? 0) } as unknown as Record<string, jest.Mock>,
    payment: { ...table(), count: jest.fn(async () => opts.counts?.payment ?? 0) } as unknown as Record<string, jest.Mock>,
    refund: table(),
    auditLog: { count: jest.fn(async () => opts.auditCount ?? 0) } as unknown as Record<string, jest.Mock>,
  };
  for (const m of [
    'refundAttempt', 'paymentEvent', 'invoiceApplication', 'notifyLog', 'houseBinding', 'houseContact',
    'houseStandard', 'ticket', 'visitorPass', 'serviceOrder', 'billBatch', 'feeRule', 'workLog',
    'announcement', 'coupon', 'serviceItem', 'communityCollectionPolicy', 'idempotencyRecord',
    'outboxEvent', 'reconciliationItem', 'reconciliationRun',
  ]) {
    if (!t[m]) t[m] = table() as unknown as Record<string, jest.Mock>;
  }
  const prisma = {
    t,
    raw: {
      paymentBill: { deleteMany: delMany },
      $executeRawUnsafe: jest.fn(async (sql: string) => {
        executed.push(sql);
        return 0;
      }),
      $executeRaw: jest.fn(async () => opts.auditCount ?? 0),
      $queryRaw: jest.fn(async () =>
        (opts.triggersBack ?? [
          'AuditLog_before_update_append_only',
          'AuditLog_before_delete_append_only',
        ]).map((TRIGGER_NAME) => ({ TRIGGER_NAME })),
      ),
    },
  };
  return { prisma, executed, delMany };
}

const svc = (prisma: unknown, audit: unknown) => new MaintenanceService(prisma as never, audit as never);
const makeAudit = () => {
  const rows: Record<string, unknown>[] = [];
  return { append: jest.fn(async (r: Record<string, unknown>) => rows.push(r)), rows };
};

describe('彻底删除房屋', () => {
  it('名字打错就不删——手滑点不出这个操作', async () => {
    const { prisma } = makePrisma({});
    const audit = makeAudit();
    await expect(
      svc(prisma, audit).purge({ target: 'HOUSE', id: 'h1', confirm: '测试房 002' } as never, 'admin-1'),
    ).rejects.toThrow(/原样输入房屋名称/);
    expect(prisma.t.house.delete).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('先写审计再动手,审计行挂 communityId=null(否则会被删小区带走)', async () => {
    const { prisma } = makePrisma({});
    const audit = makeAudit();
    const r = await svc(prisma, audit).purge(
      { target: 'HOUSE', id: 'h1', confirm: '测试房 001' } as never,
      'admin-1',
    );
    expect(r).toMatchObject({ purged: true, code: 'T-001' });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: 'DELETE', resourceType: 'House', communityId: null });
    expect(JSON.stringify(audit.rows[0].afterSummary)).toContain('HOUSE_PURGE');
    expect(prisma.t.house.delete).toHaveBeenCalled();
  });

  it('房屋不存在 → NOT_FOUND,不是静默成功', async () => {
    const { prisma } = makePrisma({ house: null });
    await expect(
      svc(prisma, makeAudit()).purge({ target: 'HOUSE', id: 'nope', confirm: 'x' } as never, 'admin-1'),
    ).rejects.toThrow(BizException);
  });
});

describe('彻底删除小区', () => {
  it('名下还有房屋/账单 → 拒绝,并且不代劳删它们', async () => {
    const { prisma } = makePrisma({ counts: { house: 551 } });
    const audit = makeAudit();
    await expect(
      svc(prisma, audit).purge(
        { target: 'COMMUNITY', id: 'c1', confirm: '【体验数据】云顶花园', purgeAuditLogs: true } as never,
        'admin-1',
      ),
    ).rejects.toThrow(/房屋 551 条/);
    expect(prisma.t.community.delete).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('有审计记录但没显式同意 → 拒绝,并说清这是唯一的例外开关', async () => {
    const { prisma } = makePrisma({ auditCount: 200 });
    await expect(
      svc(prisma, makeAudit()).purge(
        { target: 'COMMUNITY', id: 'c1', confirm: '【体验数据】云顶花园' } as never,
        'admin-1',
      ),
    ).rejects.toThrow(/审计记录 200 条[\s\S]*purgeAuditLogs/);
  });

  it('显式同意后:摘触发器 → 删审计 → 装回触发器,且「销毁了多少条」写进审计', async () => {
    const { prisma, executed } = makePrisma({ auditCount: 200 });
    const audit = makeAudit();
    const r = await svc(prisma, audit).purge(
      { target: 'COMMUNITY', id: 'c1', confirm: '【体验数据】云顶花园', purgeAuditLogs: true } as never,
      'admin-1',
    );
    expect(r).toMatchObject({ purged: true, target: 'COMMUNITY' });
    expect(r.deleted.auditLog).toBe(200);
    // 顺序:先 DROP 两个,最后 CREATE 回两个
    expect(executed.filter((s) => s.startsWith('DROP TRIGGER'))).toHaveLength(2);
    expect(executed.filter((s) => s.startsWith('CREATE TRIGGER'))).toHaveLength(2);
    expect(executed.findIndex((s) => s.startsWith('CREATE TRIGGER'))).toBeGreaterThan(
      executed.findIndex((s) => s.startsWith('DROP TRIGGER')),
    );
    // 链条断在哪里,链条自己记着
    expect(JSON.stringify(audit.rows[0].beforeSummary)).toContain('"auditLogsDestroyed":200');
    expect(audit.rows[0].communityId).toBeNull();
    expect(prisma.t.community.delete).toHaveBeenCalled();
  });

  it('触发器没装回来 → 立刻炸,绝不留一张可改可删的审计表', async () => {
    const { prisma } = makePrisma({ auditCount: 5, triggersBack: ['AuditLog_before_update_append_only'] });
    await expect(
      svc(prisma, makeAudit()).purge(
        { target: 'COMMUNITY', id: 'c1', confirm: '【体验数据】云顶花园', purgeAuditLogs: true } as never,
        'admin-1',
      ),
    ).rejects.toThrow(/触发器未能恢复/);
  });

  it('没有审计记录时不碰触发器——正常路径下审计表一秒都不会失去保护', async () => {
    const { prisma, executed } = makePrisma({ auditCount: 0 });
    await svc(prisma, makeAudit()).purge(
      { target: 'COMMUNITY', id: 'c1', confirm: '【体验数据】云顶花园' } as never,
      'admin-1',
    );
    expect(executed).toHaveLength(0);
    expect(prisma.t.community.delete).toHaveBeenCalled();
  });
});
