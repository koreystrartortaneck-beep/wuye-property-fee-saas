import { CollectionPolicyService } from './collection-policy.service';

describe('CollectionPolicyService', () => {
  function makePrisma(overrides: {
    platform?: unknown;
    tenant?: unknown;
    community?: unknown;
  } = {}) {
    return {
      raw: {
        platformCollectionPolicy: {
          findUnique: jest.fn().mockResolvedValue(overrides.platform ?? null),
        },
        tenantCollectionPolicy: {
          findUnique: jest.fn().mockResolvedValue(overrides.tenant ?? null),
        },
        communityCollectionPolicy: {
          findUnique: jest.fn().mockResolvedValue(overrides.community ?? null),
        },
      },
    };
  }

  const audit = { append: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  describe('resolveEffectiveStatus 分层优先级', () => {
    it('三层全开时收款开放', async () => {
      const prisma = makePrisma();
      const service = new CollectionPolicyService(prisma as never, audit as never);
      await expect(service.resolveEffectiveStatus('tenant-1', 'community-1')).resolves.toEqual({
        status: 'OPEN',
        pausedLayer: null,
        reason: null,
      });
    });

    it('平台暂停优先于租户与小区', async () => {
      const prisma = makePrisma({
        platform: { status: 'PAUSED', reason: '平台维护' },
        tenant: { status: 'OPEN' },
        community: { status: 'OPEN' },
      });
      const service = new CollectionPolicyService(prisma as never, audit as never);
      await expect(service.resolveEffectiveStatus('tenant-1', 'community-1')).resolves.toEqual({
        status: 'PAUSED',
        pausedLayer: 'PLATFORM',
        reason: '平台维护',
      });
    });

    it('平台开放时租户暂停优先于小区', async () => {
      const prisma = makePrisma({
        platform: { status: 'OPEN' },
        tenant: { status: 'PAUSED', reason: '租户欠费' },
        community: { status: 'PAUSED', reason: '小区暂停' },
      });
      const service = new CollectionPolicyService(prisma as never, audit as never);
      await expect(service.resolveEffectiveStatus('tenant-1', 'community-1')).resolves.toEqual({
        status: 'PAUSED',
        pausedLayer: 'TENANT',
        reason: '租户欠费',
      });
    });

    it('仅小区暂停时按小区层生效', async () => {
      const prisma = makePrisma({ community: { status: 'PAUSED', reason: '小区施工' } });
      const service = new CollectionPolicyService(prisma as never, audit as never);
      await expect(service.resolveEffectiveStatus('tenant-1', 'community-1')).resolves.toEqual({
        status: 'PAUSED',
        pausedLayer: 'COMMUNITY',
        reason: '小区施工',
      });
    });
  });

  describe('assertOpenForUpdate 事务内加锁复核', () => {
    it('在同一事务内以 FOR SHARE 复核并在暂停时拒绝', async () => {
      const prisma = makePrisma();
      const service = new CollectionPolicyService(prisma as never, audit as never);
      const queryRaw = jest
        .fn()
        .mockResolvedValueOnce([]) // platform
        .mockResolvedValueOnce([]) // tenant
        .mockResolvedValueOnce([{ status: 'PAUSED', reason: '小区暂停' }]); // community
      const tx = { $queryRaw: queryRaw };

      await expect(
        service.assertOpenForUpdate(tx as never, 'tenant-1', ['community-1']),
      ).rejects.toMatchObject({ code: 43003 });
      expect(queryRaw).toHaveBeenCalledTimes(3);
      const sql = String(queryRaw.mock.calls[0][0].sql ?? queryRaw.mock.calls[0][0]);
      expect(sql).toContain('FOR SHARE');
    });

    it('全部开放时通过复核', async () => {
      const prisma = makePrisma();
      const service = new CollectionPolicyService(prisma as never, audit as never);
      const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
      await expect(
        service.assertOpenForUpdate(tx as never, 'tenant-1', ['community-1']),
      ).resolves.toBeUndefined();
    });
  });

  describe('管理端更新', () => {
    it('缺少原因时拒绝更新', async () => {
      const prisma = makePrisma();
      const service = new CollectionPolicyService(prisma as never, audit as never);
      await expect(
        service.setTenantPolicy({ tenantId: 'tenant-1', adminId: 'admin-1', status: 'PAUSED', reason: '' }),
      ).rejects.toMatchObject({ code: 40000 });
    });

    it('更新租户策略时事务内写入审计', async () => {
      const before = { id: 'tp-1', status: 'OPEN' };
      const after = { id: 'tp-1', status: 'PAUSED' };
      const tx = {
        tenantCollectionPolicy: {
          findUnique: jest.fn().mockResolvedValue(before),
          upsert: jest.fn().mockResolvedValue(after),
        },
        auditLog: { create: jest.fn() },
      };
      const prisma = {
        raw: { $transaction: jest.fn(async (cb: (client: typeof tx) => unknown) => cb(tx)) },
      };
      const auditMock = { append: jest.fn().mockResolvedValue(undefined) };
      const service = new CollectionPolicyService(prisma as never, auditMock as never);

      await expect(
        service.setTenantPolicy({
          tenantId: 'tenant-1',
          adminId: 'admin-1',
          status: 'PAUSED',
          reason: '欠费停收',
        }),
      ).resolves.toEqual(after);
      expect(tx.tenantCollectionPolicy.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-1' },
        }),
      );
      expect(auditMock.append).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          action: 'UPDATE',
          resourceType: 'TenantCollectionPolicy',
          reason: '欠费停收',
        }),
        tx,
      );
    });
  });
});
