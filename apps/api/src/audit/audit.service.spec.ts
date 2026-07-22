import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';
import { AdminGuard } from '../auth/admin.guard';
import { AppModule } from '../app.module';
import { RolesGuard } from '../auth/roles.decorator';
import { IdempotencyService } from '../common/idempotency.service';
import { AdminAuditController } from './admin-audit.controller';
import { AuditModule } from './audit.module';
import { AuditService } from './audit.service';

const auditInput = {
  tenantId: 'tenant-1',
  communityId: 'community-1',
  actorType: 'ADMIN' as const,
  actorId: 'admin-1',
  action: 'UPDATE' as const,
  resourceType: 'Bill',
  resourceId: 'bill-1',
  reason: 'correction',
  requestId: 'request-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
  beforeSummary: { amount: 100 },
  afterSummary: { amount: 200 },
};

function createHarness() {
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'audit-1',
    createdAt: new Date('2026-07-22T00:00:00.000Z'),
    ...data,
  }));
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);
  const prisma = {
    t: { auditLog: { create, findMany, count } },
    raw: { auditLog: { findMany: jest.fn(), count: jest.fn() } },
  } as unknown as PrismaService;
  return { service: new AuditService(prisma), create, findMany, count, prisma };
}

describe('AuditService', () => {
  it('appends every audit field through a caller transaction', async () => {
    const { service, create: defaultCreate } = createHarness();
    const txCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'audit-tx',
      ...data,
    }));
    const tx = { auditLog: { create: txCreate } };

    const result = await runWithTenant('tenant-1', () => service.append(auditInput, tx as never));

    expect(result).toMatchObject({ id: 'audit-tx', ...auditInput });
    expect(txCreate).toHaveBeenCalledWith({ data: auditInput });
    expect(defaultCreate).not.toHaveBeenCalled();
  });

  it('recursively redacts sensitive keys and full phone values before persistence', async () => {
    const { service, create } = createHarness();
    const input = {
      ...auditInput,
      beforeSummary: {
        password: 'p@ssword',
        safe: 'visible',
        nested: [
          {
            apiV3Key: 'api-v3-secret',
            authorization: 'Bearer header-token',
            privateKey: '-----BEGIN PRIVATE KEY-----private-material',
            rawCallback: '<xml>raw</xml>',
            openid: 'openid-secret',
            phone: '13800138000',
          },
        ],
      },
      afterSummary: {
        contact: 'call 13900139000 tomorrow',
        diagnostic:
          "apiV3Key=plain-api-secret token:plain-token password whitespace-secret rawCallback='<xml>sensitive</xml>'",
        tokenizedCount: 3,
      },
    };

    await runWithTenant('tenant-1', () => service.append(input));

    const stored = (create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    const serialized = JSON.stringify(stored);
    expect(serialized).toContain('visible');
    for (const secret of [
      'p@ssword',
      'api-v3-secret',
      'header-token',
      'private-material',
      '<xml>raw</xml>',
      'openid-secret',
      '13800138000',
      '13900139000',
      'plain-api-secret',
      'plain-token',
      'whitespace-secret',
      '<xml>sensitive</xml>',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(stored.afterSummary).toMatchObject({ tokenizedCount: 3 });
  });

  it('redacts JSON-encoded credentials and non-Bearer authorization values', async () => {
    const { service, create } = createHarness();

    await runWithTenant('tenant-1', () =>
      service.append({
        ...auditInput,
        beforeSummary: {
          json: 'callback={"token":"json-token","nested":{"phone":"13800138000"}}',
          diagnostic:
            'authorization: Custom custom-auth-value\ncookie: sid=session-cookie; csrf=cookie-csrf\napiKey=free-api-key api_key=underscored-api-key apikey=compact-free-api-key',
          compactKeys: {
            apikey: 'compact-api-key',
            appsecret: 'app-secret',
            clientsecret: 'client-secret',
            sessionid: 'session-id',
            credentials: 'credential-value',
          },
        },
      }),
    );

    const serialized = JSON.stringify(
      (create.mock.calls[0][0] as { data: Record<string, unknown> }).data,
    );
    for (const secret of [
      'json-token',
      '13800138000',
      'custom-auth-value',
      'session-cookie',
      'cookie-csrf',
      'free-api-key',
      'underscored-api-key',
      'compact-free-api-key',
      'compact-api-key',
      'app-secret',
      'client-secret',
      'session-id',
      'credential-value',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('normalizes JSON-compatible objects and rejects circular summaries', async () => {
    const { service, create } = createHarness();
    await runWithTenant('tenant-1', () =>
      service.append({
        ...auditInput,
        beforeSummary: { occurredAt: new Date('2026-07-22T01:02:03.004Z') },
      }),
    );
    expect(
      (create.mock.calls[0][0] as { data: Record<string, unknown> }).data.beforeSummary,
    ).toEqual({ occurredAt: '2026-07-22T01:02:03.004Z' });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      runWithTenant('tenant-1', () =>
        service.append({ ...auditInput, beforeSummary: circular }),
      ),
    ).rejects.toMatchObject({ code: 40000 });
  });

  it('uses the Prisma JSON-null sentinel for explicit null summaries', async () => {
    const { service, create } = createHarness();

    await runWithTenant('tenant-1', () =>
      service.append({ ...auditInput, beforeSummary: null, afterSummary: null }),
    );

    const stored = (create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(stored.beforeSummary).toBe(Prisma.JsonNull);
    expect(stored.afterSummary).toBe(Prisma.JsonNull);
  });

  it('redacts and bounds free-text audit metadata', async () => {
    const { service, create } = createHarness();

    await runWithTenant('tenant-1', () =>
      service.append({
        ...auditInput,
        reason: `token=reason-secret phone 13800138000 ${'r'.repeat(300)}`,
        userAgent: `authorization: Basic dXNlcjpwYXNz ${'u'.repeat(300)}`,
      }),
    );

    const stored = (create.mock.calls[0][0] as { data: Record<string, string> }).data;
    expect(stored.reason).toHaveLength(191);
    expect(stored.userAgent.length).toBeLessThanOrEqual(191);
    expect(stored.reason).not.toContain('reason-secret');
    expect(stored.reason).not.toContain('13800138000');
    expect(stored.userAgent).not.toContain('dXNlcjpwYXNz');
  });

  it('rejects transaction writes when no tenant context is active', async () => {
    const { service } = createHarness();
    const transaction = { auditLog: { create: jest.fn() } };

    await expect(service.append(auditInput, transaction as never)).rejects.toMatchObject({
      code: 40300,
    });
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects an explicit tenant that differs from the active tenant context', async () => {
    const { service, create } = createHarness();

    await expect(
      runWithTenant('tenant-2', () => service.append(auditInput)),
    ).rejects.toMatchObject({ code: 40300 });
    expect(create).not.toHaveBeenCalled();
  });

  it('lists only through the tenant client with all supported filters and sanitizes legacy rows', async () => {
    const { service, findMany, count, prisma } = createHarness();
    findMany.mockResolvedValue([
      {
        id: 'audit-legacy',
        tenantId: 'tenant-1',
        reason: 'credentials=legacy-credential',
        userAgent: 'Authorization: Custom legacy-auth-value',
        beforeSummary: { password: 'legacy-secret', amount: 1 },
        afterSummary: { phone: '13800138000', amount: 2 },
      },
    ]);
    count.mockResolvedValue(1);

    const result = await runWithTenant('tenant-1', () =>
      service.list({
        page: 2,
        pageSize: 10,
        action: 'UPDATE',
        actorId: 'admin-1',
        resourceType: 'Bill',
        resourceId: 'bill-1',
        communityId: 'community-1',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-31T23:59:59.999Z',
      }),
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        action: 'UPDATE',
        actorId: 'admin-1',
        resourceType: 'Bill',
        resourceId: 'bill-1',
        communityId: 'community-1',
        createdAt: {
          gte: new Date('2026-07-01T00:00:00.000Z'),
          lte: new Date('2026-07-31T23:59:59.999Z'),
        },
      },
      skip: 10,
      take: 10,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(count).toHaveBeenCalledWith({ where: expect.any(Object) });
    expect(prisma.raw.auditLog.findMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ total: 1, page: 2, pageSize: 10 });
    expect(JSON.stringify(result.list)).not.toContain('legacy-secret');
    expect(JSON.stringify(result.list)).not.toContain('legacy-credential');
    expect(JSON.stringify(result.list)).not.toContain('legacy-auth-value');
    expect(JSON.stringify(result.list)).not.toContain('13800138000');
  });
});

describe('AuditModule wiring', () => {
  it('registers global infrastructure and is imported by AppModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AuditModule)).toEqual(
      expect.arrayContaining([AuditService, IdempotencyService]),
    );
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AuditModule)).toEqual([
      AdminAuditController,
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, AuditModule)).toEqual(
      expect.arrayContaining([AuditService, IdempotencyService]),
    );
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule)).toContain(AuditModule);
  });
});

describe('AdminAuditController', () => {
  it('exposes only guarded GET /admin/audit-logs and delegates read filters', async () => {
    const list = jest.fn().mockResolvedValue({ list: [], total: 0, page: 1, pageSize: 20 });
    const controller = new AdminAuditController({ list } as unknown as AuditService);
    const query = { page: 1, pageSize: 20, actorId: 'admin-1' };

    await expect(controller.list(query)).resolves.toMatchObject({ total: 0 });
    expect(list).toHaveBeenCalledWith(query);
    expect(Reflect.getMetadata(PATH_METADATA, AdminAuditController)).toBe('admin/audit-logs');
    expect(Reflect.getMetadata(METHOD_METADATA, AdminAuditController.prototype.list)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminAuditController)).toEqual([
      AdminGuard,
      RolesGuard,
    ]);
    expect(Object.getOwnPropertyNames(AdminAuditController.prototype)).toEqual([
      'constructor',
      'list',
    ]);
  });
});
