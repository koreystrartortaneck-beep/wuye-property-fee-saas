import { IncidentService } from './incident.service';

describe('IncidentService 事件生命周期', () => {
  let audit: { append: jest.Mock };
  let store: any[];

  beforeEach(() => {
    audit = { append: jest.fn().mockResolvedValue(undefined) };
    store = [];
  });

  function makePrisma() {
    return {
      raw: {
        incident: {
          findUnique: jest.fn(async ({ where }: any) => {
            if (where.tenantId_dedupKey) {
              return store.find((r) => r.tenantId === where.tenantId_dedupKey.tenantId && r.dedupKey === where.tenantId_dedupKey.dedupKey) || null;
            }
            return store.find((r) => r.tenantId === where.tenantId_id.tenantId && r.id === where.tenantId_id.id) || null;
          }),
          create: jest.fn(async ({ data }: any) => {
            const row = { id: `inc-${store.length + 1}`, occurrences: 1, ...data };
            store.push(row);
            return row;
          }),
          update: jest.fn(async ({ where, data }: any) => {
            const row = store.find((r) => r.id === where.tenantId_id.id);
            for (const [k, v] of Object.entries<any>(data)) {
              if (v && typeof v === 'object' && 'increment' in v) row[k] = (row[k] || 0) + v.increment;
              else row[k] = v;
            }
            return row;
          }),
        },
      },
      t: { incident: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) } },
    };
  }

  const make = (prisma: any) => new IncidentService(prisma as never, audit as never);
  const base = { tenantId: 'tenant-1', communityId: 'community-1', dedupKey: 'recon-diff:2026-07-10', title: '对账差异', severity: 'CRITICAL' as const };

  it('首次触发创建 OPEN 事件并写审计', async () => {
    const prisma = makePrisma();
    const svc = make(prisma);
    const inc = await svc.openOrReopen(base);
    expect(inc.status).toBe('OPEN');
    expect(prisma.raw.incident.create).toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'Incident' }), undefined);
  });

  it('重复触发累加次数不新建', async () => {
    const prisma = makePrisma();
    const svc = make(prisma);
    await svc.openOrReopen(base);
    const again = await svc.openOrReopen(base);
    expect(prisma.raw.incident.create).toHaveBeenCalledTimes(1);
    expect(again.occurrences).toBe(2);
  });

  it('确认与解决按状态机推进且幂等，记审计', async () => {
    const prisma = makePrisma();
    const svc = make(prisma);
    const inc = await svc.openOrReopen(base);
    const ack = await svc.acknowledge({ tenantId: 'tenant-1', id: inc.id, adminId: 'admin-1', reason: '排查中' });
    expect(ack.status).toBe('ACKNOWLEDGED');
    // 幂等：再次确认仍成功
    const ack2 = await svc.acknowledge({ tenantId: 'tenant-1', id: inc.id, adminId: 'admin-1' });
    expect(ack2.status).toBe('ACKNOWLEDGED');
    const resolved = await svc.resolve({ tenantId: 'tenant-1', id: inc.id, adminId: 'admin-1', reason: '已修复' });
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolvedAt).toBeTruthy();
    const resolved2 = await svc.resolve({ tenantId: 'tenant-1', id: inc.id, adminId: 'admin-1' });
    expect(resolved2.status).toBe('RESOLVED');
  });

  it('解决后再次复发重新打开事件', async () => {
    const prisma = makePrisma();
    const svc = make(prisma);
    const inc = await svc.openOrReopen(base);
    await svc.resolve({ tenantId: 'tenant-1', id: inc.id, adminId: 'admin-1' });
    const reopened = await svc.openOrReopen(base);
    expect(reopened.status).toBe('OPEN');
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.occurrences).toBe(2);
  });

  it('租户隔离：查询带 tenantId 条件', async () => {
    const prisma = makePrisma();
    const svc = make(prisma);
    await svc.list({ tenantId: 'tenant-1', page: 1, pageSize: 20 });
    const arg = prisma.t.incident.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe('tenant-1');
  });
});
