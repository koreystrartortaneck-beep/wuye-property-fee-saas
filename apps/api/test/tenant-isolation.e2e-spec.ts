import { PrismaService } from '../src/prisma/prisma.service';
import { runWithTenant } from '../src/tenant/tenant-cls';

describe('租户行级隔离（真库）', () => {
  const prisma = new PrismaService();
  let tenantA: string;
  let tenantB: string;
  let communityAId: string;
  let communityBId: string;
  let eventAId: string;
  let eventBId: string;

  beforeAll(async () => {
    const oldTenants = await prisma.raw.tenant.findMany({
      where: { code: { in: ['iso-a', 'iso-b'] } },
      select: { id: true },
    });
    const oldTenantIds = oldTenants.map(({ id }) => id);
    if (oldTenantIds.length > 0) {
      await prisma.raw.outboxEvent.deleteMany({ where: { tenantId: { in: oldTenantIds } } });
      await prisma.raw.community.deleteMany({ where: { tenantId: { in: oldTenantIds } } });
      await prisma.raw.tenant.deleteMany({ where: { id: { in: oldTenantIds } } });
    }

    tenantA = (await prisma.raw.tenant.create({ data: { name: '隔离测试A', code: 'iso-a' } })).id;
    tenantB = (await prisma.raw.tenant.create({ data: { name: '隔离测试B', code: 'iso-b' } })).id;
    communityAId = (
      await prisma.raw.community.create({ data: { tenantId: tenantA, name: '隔离测试小区A' } })
    ).id;
    communityBId = (
      await prisma.raw.community.create({ data: { tenantId: tenantB, name: '隔离测试小区B' } })
    ).id;

    const eventA = await runWithTenant(tenantA, () =>
      prisma.t.outboxEvent.create({
        data: {
          tenantId: tenantB,
          communityId: communityAId,
          aggregateType: 'TenantIsolation',
          aggregateId: 'a',
          eventType: 'CREATED',
          dedupKey: 'tenant-isolation-a',
          payload: { owner: 'a' },
        } as never,
      }),
    );
    const eventB = await runWithTenant(tenantB, () =>
      prisma.t.outboxEvent.create({
        data: {
          tenantId: tenantA,
          communityId: communityBId,
          aggregateType: 'TenantIsolation',
          aggregateId: 'b',
          eventType: 'CREATED',
          dedupKey: 'tenant-isolation-b',
          payload: { owner: 'b' },
        } as never,
      }),
    );
    eventAId = eventA.id;
    eventBId = eventB.id;
  });

  afterAll(async () => {
    if (tenantA && tenantB) {
      await prisma.raw.outboxEvent.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
      await prisma.raw.community.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
      await prisma.raw.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    }
    await prisma.$disconnect();
  });

  it('create 始终覆盖调用方伪造的 tenantId', async () => {
    const [eventA, eventB] = await Promise.all([
      prisma.raw.outboxEvent.findUniqueOrThrow({ where: { id: eventAId } }),
      prisma.raw.outboxEvent.findUniqueOrThrow({ where: { id: eventBId } }),
    ]);
    expect(eventA.tenantId).toBe(tenantA);
    expect(eventB.tenantId).toBe(tenantB);
  });

  it('两个租户各自只能读到自己的真实财务行', async () => {
    const listA = await runWithTenant(tenantA, () =>
      prisma.t.outboxEvent.findMany({ where: { aggregateType: 'TenantIsolation' } }),
    );
    const listB = await runWithTenant(tenantB, () =>
      prisma.t.outboxEvent.findMany({ where: { aggregateType: 'TenantIsolation' } }),
    );

    expect(listA.map(({ id }) => id)).toEqual([eventAId]);
    expect(listB.map(({ id }) => id)).toEqual([eventBId]);
    expect(
      await runWithTenant(tenantB, () =>
        prisma.t.outboxEvent.findUnique({ where: { id: eventAId } }),
      ),
    ).toBeNull();
  });

  it('复合外键拒绝把本租户房屋关联到另一租户小区', async () => {
    await expect(
      prisma.raw.house.create({
        data: {
          tenantId: tenantA,
          communityId: communityBId,
          code: 'cross-tenant-house',
          displayName: 'Cross tenant house',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('跨租户 update/updateMany 均不能修改目标行', async () => {
    const many = await runWithTenant(tenantB, () =>
      prisma.t.outboxEvent.updateMany({
        where: { id: eventAId },
        data: { eventType: 'TAMPERED' },
      }),
    );
    expect(many.count).toBe(0);

    await expect(
      runWithTenant(tenantB, () =>
        prisma.t.outboxEvent.update({
          where: { id: eventAId },
          data: { eventType: 'TAMPERED' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });
    expect((await prisma.raw.outboxEvent.findUniqueOrThrow({ where: { id: eventAId } })).eventType).toBe(
      'CREATED',
    );
  });

  it('跨租户 delete/deleteMany 均不能删除目标行', async () => {
    const many = await runWithTenant(tenantB, () =>
      prisma.t.outboxEvent.deleteMany({ where: { id: eventAId } }),
    );
    expect(many.count).toBe(0);

    await expect(
      runWithTenant(tenantB, () => prisma.t.outboxEvent.delete({ where: { id: eventAId } })),
    ).rejects.toMatchObject({ code: 'P2025' });
    expect(await prisma.raw.outboxEvent.findUnique({ where: { id: eventAId } })).not.toBeNull();
  });

  it('update 不能把本租户记录改挂到另一个 tenantId', async () => {
    let storedTenantId: string | undefined;
    try {
      await runWithTenant(tenantA, () =>
        prisma.t.outboxEvent.update({
          where: { id: eventAId },
          data: { tenantId: tenantB } as never,
        }),
      );
      storedTenantId = (
        await prisma.raw.outboxEvent.findUniqueOrThrow({ where: { id: eventAId } })
      ).tenantId;
    } finally {
      const stored = await prisma.raw.outboxEvent.findUnique({ where: { id: eventAId } });
      if (stored && stored.tenantId !== tenantA) {
        await prisma.raw.outboxEvent.update({
          where: { id: eventAId },
          data: { tenantId: tenantA },
        });
      }
    }
    expect(storedTenantId).toBe(tenantA);
  });

  it('无租户上下文时读为空、写被拒绝', async () => {
    expect(await prisma.t.outboxEvent.findMany()).toHaveLength(0);
    await expect(
      prisma.t.outboxEvent.create({
        data: {
          aggregateType: 'TenantIsolation',
          aggregateId: 'none',
          eventType: 'CREATED',
          dedupKey: 'tenant-isolation-none',
          payload: {},
        } as never,
      }),
    ).rejects.toThrow();
  });

  it('超管可见两个租户，非租户模型不受过滤', async () => {
    const list = await runWithTenant(null, () =>
      prisma.t.outboxEvent.findMany({ where: { aggregateType: 'TenantIsolation' } }),
    );
    expect(new Set(list.map(({ id }) => id))).toEqual(new Set([eventAId, eventBId]));

    const tenant = await runWithTenant(tenantB, () =>
      prisma.t.tenant.findUnique({ where: { id: tenantA } }),
    );
    expect(tenant?.id).toBe(tenantA);
  });
});
