import { PrismaService } from '../src/prisma/prisma.service';
import { runWithTenant } from '../src/tenant/tenant-cls';

describe('租户行级隔离（真库）', () => {
  const prisma = new PrismaService();
  let tenantA: string;
  let tenantB: string;
  let communityAId: string;

  beforeAll(async () => {
    await prisma.raw.community.deleteMany({ where: { name: { startsWith: '隔离测试' } } });
    await prisma.raw.tenant.deleteMany({ where: { code: { in: ['iso-a', 'iso-b'] } } });
    tenantA = (await prisma.raw.tenant.create({ data: { name: '隔离测试A', code: 'iso-a' } })).id;
    tenantB = (await prisma.raw.tenant.create({ data: { name: '隔离测试B', code: 'iso-b' } })).id;
  });

  afterAll(async () => {
    await prisma.raw.community.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await prisma.raw.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
  });

  it('租户 A 创建的小区自动写入 tenantId，A 可见', async () => {
    const created = await runWithTenant(tenantA, () =>
      prisma.t.community.create({ data: { name: '隔离测试小区' } as never }),
    );
    communityAId = created.id;
    expect(created.tenantId).toBe(tenantA);

    const list = await runWithTenant(tenantA, () => prisma.t.community.findMany());
    expect(list.map((c) => c.id)).toContain(communityAId);
  });

  it('租户 B 查不到 A 的数据（findMany / findUnique / count）', async () => {
    const list = await runWithTenant(tenantB, () => prisma.t.community.findMany());
    expect(list).toHaveLength(0);

    const one = await runWithTenant(tenantB, () =>
      prisma.t.community.findUnique({ where: { id: communityAId } }),
    );
    expect(one).toBeNull();

    const n = await runWithTenant(tenantB, () => prisma.t.community.count());
    expect(n).toBe(0);
  });

  it('租户 B 改不动 A 的数据', async () => {
    const r = await runWithTenant(tenantB, () =>
      prisma.t.community.updateMany({ where: { id: communityAId }, data: { name: '被篡改' } }),
    );
    expect(r.count).toBe(0);
  });

  it('无租户上下文：读为空、写抛错', async () => {
    const list = await prisma.t.community.findMany();
    expect(list).toHaveLength(0);

    await expect(prisma.t.community.create({ data: { name: '隔离测试无上下文' } as never })).rejects.toThrow();
  });

  it('超管平台视角（tenantId=null）可见全部', async () => {
    const list = await runWithTenant(null, () =>
      prisma.t.community.findMany({ where: { name: { startsWith: '隔离测试' } } }),
    );
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it('非租户模型（Tenant/WxUser）不受影响', async () => {
    const t = await runWithTenant(tenantB, () => prisma.t.tenant.findUnique({ where: { id: tenantA } }));
    expect(t?.id).toBe(tenantA);
  });
});
