import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AuditService } from '../src/audit/audit.service';
import { IdempotencyService } from '../src/common/idempotency.service';
import { OutboxService } from '../src/notify/outbox.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { runWithTenant } from '../src/tenant/tenant-cls';
import { createTestApp } from './test-app';

jest.setTimeout(120_000);

const apiRoot = join(__dirname, '..');
const prismaCli = require.resolve('prisma/build/index.js');
const migrationFiles = [
  join(apiRoot, 'prisma/migrations/20260703024539_init/migration.sql'),
  join(apiRoot, 'prisma/migrations/20260704071459_phase2_tickets_visitors_announcements/migration.sql'),
  join(apiRoot, 'prisma/migrations/20260711035914_phase3_worklog_service_coupon/migration.sql'),
  join(apiRoot, 'prisma/migrations/20260722010000_finance_expand/migration.sql'),
  join(apiRoot, 'prisma/migrations/20260722030000_admin_session_hardening/migration.sql'),
  join(apiRoot, 'prisma/migrations/20260722120000_owner_identity_hardening/migration.sql'),
];
const auditGuardMigrationFile = join(
  apiRoot,
  'prisma/migrations/20260722010300_audit_guards/migration.sql',
);

function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('audit guard E2E requires DATABASE_URL');
  return value;
}

const baseDatabaseUrl = requireDatabaseUrl();

function databaseUrl(databaseName: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function applyMigration(url: string, file: string): void {
  const result = spawnSync(
    process.execPath,
    [prismaCli, 'db', 'execute', '--file', file, '--url', url],
    {
      cwd: apiRoot,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: url },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr, result.error?.message]
      .filter(Boolean)
      .join('\n');
    throw new Error(`migration failed: ${file}\n${output}`);
  }
}

async function withClient<T>(url: string, fn: (client: PrismaClient) => Promise<T>): Promise<T> {
  const client = new PrismaClient({ datasourceUrl: url });
  try {
    await client.$connect();
    return await fn(client);
  } finally {
    await client.$disconnect();
  }
}

function createBarrier(parties: number): () => Promise<void> {
  let waiting = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    waiting += 1;
    if (waiting === parties) release();
    await released;
  };
}

describe('AuditLog append-only guards (real MySQL)', () => {
  const createdDatabases = new Set<string>();
  const admin = new PrismaClient({ datasourceUrl: databaseUrl('mysql') });

  async function createDatabase(label: string): Promise<{ name: string; url: string }> {
    const name = `pf_audit_${label}_${process.pid}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await admin.$executeRawUnsafe(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    createdDatabases.add(name);
    const url = databaseUrl(name);
    for (const migration of migrationFiles) applyMigration(url, migration);
    return { name, url };
  }

  async function dropDatabase(name: string): Promise<void> {
    if (!createdDatabases.has(name)) return;
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${name}\``);
    createdDatabases.delete(name);
  }

  async function seedTenantAndAudit(client: PrismaClient, suffix: string) {
    const tenant = await client.tenant.create({
      data: { id: `tenant-${suffix}`, name: `Tenant ${suffix}`, code: `tenant-${suffix}` },
    });
    const community = await client.community.create({
      data: { id: `community-${suffix}`, tenantId: tenant.id, name: `Community ${suffix}` },
    });
    const audit = await client.auditLog.create({
      data: {
        id: `audit-${suffix}`,
        tenantId: tenant.id,
        communityId: community.id,
        actorType: 'ADMIN',
        actorId: `admin-${suffix}`,
        action: 'UPDATE',
        resourceType: 'Bill',
        resourceId: `bill-${suffix}`,
        beforeSummary: { amount: 100 },
        afterSummary: { amount: 200 },
      },
    });
    return { tenant, community, audit };
  }

  beforeAll(async () => {
    await admin.$connect();
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    try {
      for (const name of [...createdDatabases]) {
        try {
          await dropDatabase(name);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    } finally {
      try {
        await admin.$disconnect();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'failed to clean audit guard test databases');
    }
  });

  it('applies to an empty AuditLog table, permits create, and rejects update/delete', async () => {
    const database = await createDatabase('empty');
    try {
      applyMigration(database.url, auditGuardMigrationFile);
      await withClient(database.url, async (client) => {
        const { audit } = await seedTenantAndAudit(client, 'empty');
        expect(audit.resourceId).toBe('bill-empty');

        await expect(
          client.auditLog.update({
            where: { id: audit.id },
            data: { reason: 'tampered' },
          }),
        ).rejects.toThrow(/append-only/i);
        await expect(client.auditLog.delete({ where: { id: audit.id } })).rejects.toThrow(
          /append-only/i,
        );
        await expect(client.auditLog.findUnique({ where: { id: audit.id } })).resolves.toMatchObject(
          {
            id: audit.id,
            reason: null,
          },
        );
      });
    } finally {
      await dropDatabase(database.name);
    }
  });

  it('rejects orphan tenant references before persistent DDL and preserves the audit row', async () => {
    const database = await createDatabase('orphan');
    try {
      await withClient(database.url, async (client) => {
        await client.$executeRaw`
          INSERT INTO \`AuditLog\` (
            \`id\`, \`tenantId\`, \`communityId\`, \`action\`, \`resourceType\`, \`resourceId\`
          ) VALUES (
            'orphan-audit', 'missing-tenant', NULL, 'UPDATE', 'Tenant', 'missing-tenant'
          )
        `;
      });

      expect(() => applyMigration(database.url, auditGuardMigrationFile)).toThrow(
        /audit_guards_preflight_tenant_reference_chk/i,
      );

      await withClient(database.url, async (client) => {
        const rows = await client.$queryRaw<Array<{ id: string; tenantId: string }>>`
          SELECT \`id\`, \`tenantId\` FROM \`AuditLog\` WHERE \`id\` = 'orphan-audit'
        `;
        expect(rows).toEqual([{ id: 'orphan-audit', tenantId: 'missing-tenant' }]);
        const triggers = await client.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*) AS \`count\`
          FROM information_schema.TRIGGERS
          WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'AuditLog'
        `;
        expect(Number(triggers[0].count)).toBe(0);
      });
    } finally {
      await dropDatabase(database.name);
    }
  });

  it('applies safely with existing rows and preserves Community ON DELETE RESTRICT', async () => {
    const database = await createDatabase('existing');
    try {
      let ids!: { auditId: string; communityId: string };
      await withClient(database.url, async (client) => {
        const seeded = await seedTenantAndAudit(client, 'existing');
        ids = { auditId: seeded.audit.id, communityId: seeded.community.id };
        await client.tenant.create({
          data: { id: 'tenant-with-global-audit', name: 'Global Audit', code: 'global-audit' },
        });
        await client.auditLog.create({
          data: {
            id: 'global-audit',
            tenantId: 'tenant-with-global-audit',
            action: 'UPDATE',
            resourceType: 'TenantPolicy',
            resourceId: 'tenant-with-global-audit',
          },
        });
      });

      applyMigration(database.url, auditGuardMigrationFile);

      await withClient(database.url, async (client) => {
        await expect(
          client.auditLog.update({
            where: { id: ids.auditId },
            data: { resourceId: 'rewritten' },
          }),
        ).rejects.toThrow(/append-only/i);
        await expect(client.auditLog.delete({ where: { id: ids.auditId } })).rejects.toThrow(
          /append-only/i,
        );
        await expect(
          client.community.update({
            where: { id: ids.communityId },
            data: { id: 'rewritten-community-id' },
          }),
        ).rejects.toMatchObject({ code: 'P2003' });
        await expect(client.community.delete({ where: { id: ids.communityId } })).rejects.toMatchObject(
          { code: 'P2003' },
        );

        await expect(
          client.tenant.delete({ where: { id: 'tenant-with-global-audit' } }),
        ).rejects.toMatchObject({ code: 'P2003' });

        const triggers = await client.$queryRaw<
          Array<{ TRIGGER_NAME: string; EVENT_MANIPULATION: string }>
        >`
          SELECT TRIGGER_NAME, EVENT_MANIPULATION
          FROM information_schema.TRIGGERS
          WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'AuditLog'
          ORDER BY TRIGGER_NAME
        `;
        expect(triggers).toEqual([
          { TRIGGER_NAME: 'AuditLog_before_delete_append_only', EVENT_MANIPULATION: 'DELETE' },
          { TRIGGER_NAME: 'AuditLog_before_update_append_only', EVENT_MANIPULATION: 'UPDATE' },
        ]);

        const foreignKeys = await client.$queryRaw<
          Array<{ CONSTRAINT_NAME: string; DELETE_RULE: string; UPDATE_RULE: string }>
        >`
          SELECT CONSTRAINT_NAME, DELETE_RULE, UPDATE_RULE
          FROM information_schema.REFERENTIAL_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE()
            AND CONSTRAINT_NAME IN (
              'AuditLog_tenantId_communityId_restrict_fkey',
              'AuditLog_tenantId_fkey'
            )
          ORDER BY CONSTRAINT_NAME
        `;
        expect(foreignKeys).toEqual([
          {
            CONSTRAINT_NAME: 'AuditLog_tenantId_communityId_restrict_fkey',
            DELETE_RULE: 'RESTRICT',
            UPDATE_RULE: 'RESTRICT',
          },
          {
            CONSTRAINT_NAME: 'AuditLog_tenantId_fkey',
            DELETE_RULE: 'RESTRICT',
            UPDATE_RULE: 'RESTRICT',
          },
        ]);
      });
    } finally {
      await dropDatabase(database.name);
    }
  });

  it('rolls back caller-transaction audit, idempotency, and Outbox writes together', async () => {
    const database = await createDatabase('rollback');
    const previousDatabaseUrl = process.env.DATABASE_URL;
    let app: INestApplication | undefined;
    try {
      applyMigration(database.url, auditGuardMigrationFile);
      process.env.DATABASE_URL = database.url;
      app = await createTestApp();
      const prisma = app.get(PrismaService);
      const audit = app.get(AuditService);
      const idempotency = app.get(IdempotencyService);
      const outbox = app.get(OutboxService);
      const tenant = await prisma.raw.tenant.create({
        data: { id: 'rollback-tenant', name: 'Rollback', code: 'rollback' },
      });

      await expect(
        runWithTenant(tenant.id, () =>
          prisma.raw.$transaction(async (transaction) => {
            await audit.append(
              {
                tenantId: tenant.id,
                actorType: 'SYSTEM',
                action: 'UPDATE',
                resourceType: 'Bill',
                resourceId: 'rollback-bill',
                beforeSummary: null,
                afterSummary: { token: 'rollback-secret', amount: 1 },
              },
              transaction,
            );
            const reservation = await idempotency.reserve(
              {
                tenantId: tenant.id,
                actorKey: 'system:rollback',
                action: 'ROLLBACK_TEST',
                requestId: 'rollback-request',
                payload: { billId: 'rollback-bill' },
              },
              transaction,
            );
            if (reservation.outcome !== 'RESERVED') throw new Error('expected reservation');
            await idempotency.complete(
              {
                tenantId: tenant.id,
                recordId: reservation.recordId,
                responseCode: 200,
                responseBody: { ok: true },
              },
              transaction,
            );
            await outbox.enqueue(
              {
                tenantId: tenant.id,
                aggregateType: 'Bill',
                aggregateId: 'rollback-bill',
                eventType: 'BILL_UPDATED',
                dedupKey: 'rollback-bill:updated',
                payload: { billId: 'rollback-bill' },
              },
              transaction,
            );
            throw new Error('force rollback');
          }),
        ),
      ).rejects.toThrow('force rollback');

      await expect(
        Promise.all([
          prisma.raw.auditLog.count({ where: { tenantId: tenant.id } }),
          prisma.raw.idempotencyRecord.count({ where: { tenantId: tenant.id } }),
          prisma.raw.outboxEvent.count({ where: { tenantId: tenant.id } }),
        ]),
      ).resolves.toEqual([0, 0, 0]);

      const committedAudit = await runWithTenant(tenant.id, () =>
        audit.append({
          tenantId: tenant.id,
          actorType: 'SYSTEM',
          action: 'CREATE',
          resourceType: 'Bill',
          resourceId: 'committed-bill',
          beforeSummary: null,
          reason: 'token=reason-secret phone 13800138000',
        }),
      );
      expect(committedAudit.beforeSummary).toBeNull();
      expect(committedAudit.reason).not.toContain('reason-secret');
      expect(committedAudit.reason).not.toContain('13800138000');
    } finally {
      if (app) await app.close();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      await dropDatabase(database.name);
    }
  });

  it('handles stale transaction snapshots and concurrent Outbox claims on real MySQL', async () => {
    const database = await createDatabase('concurrency');
    const previousDatabaseUrl = process.env.DATABASE_URL;
    let app: INestApplication | undefined;
    try {
      applyMigration(database.url, auditGuardMigrationFile);
      process.env.DATABASE_URL = database.url;
      app = await createTestApp();
      const prisma = app.get(PrismaService);
      const idempotency = app.get(IdempotencyService);
      const outbox = app.get(OutboxService);
      const tenant = await prisma.raw.tenant.create({
        data: { id: 'concurrency-tenant', name: 'Concurrency', code: 'concurrency' },
      });

      let releaseIdempotency!: () => void;
      let snapshotIdempotency!: () => void;
      const idempotencySnapshotReady = new Promise<void>((resolve) => {
        snapshotIdempotency = resolve;
      });
      const idempotencyRelease = new Promise<void>((resolve) => {
        releaseIdempotency = resolve;
      });
      const idempotencyInput = {
        tenantId: tenant.id,
        actorKey: 'admin:concurrency',
        action: 'PAY_BILL',
        requestId: 'stale-snapshot',
        payload: { billId: 'bill-concurrency' },
      };
      const winningReservation = await runWithTenant(tenant.id, () =>
        idempotency.reserve(idempotencyInput),
      );
      if (winningReservation.outcome !== 'RESERVED') throw new Error('expected reservation');
      const staleReservation = prisma.raw.$transaction(async (transaction) => {
        await transaction.idempotencyRecord.findMany({ where: { tenantId: tenant.id } });
        snapshotIdempotency();
        await idempotencyRelease;
        return runWithTenant(tenant.id, () => idempotency.reserve(idempotencyInput, transaction));
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      await idempotencySnapshotReady;
      await runWithTenant(tenant.id, () =>
        idempotency.complete({
          tenantId: tenant.id,
          recordId: winningReservation.recordId,
          responseCode: 200,
          responseBody: { ok: true },
        }),
      );
      releaseIdempotency();
      await expect(staleReservation).resolves.toMatchObject({
        outcome: 'REPLAY',
        responseCode: 200,
        responseBody: { ok: true },
      });

      const idempotencyDuplicateBarrier = createBarrier(2);
      const duplicateReservations = await Promise.all(
        [1, 2].map(() =>
          prisma.raw.$transaction(
            async (transaction) => {
              await transaction.idempotencyRecord.findMany({ where: { tenantId: tenant.id } });
              await idempotencyDuplicateBarrier();
              return runWithTenant(tenant.id, () =>
                idempotency.reserve(idempotencyInput, transaction),
              );
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
          ),
        ),
      );
      expect(duplicateReservations).toEqual([
        expect.objectContaining({ outcome: 'REPLAY', responseCode: 200 }),
        expect.objectContaining({ outcome: 'REPLAY', responseCode: 200 }),
      ]);

      let releaseOutbox!: () => void;
      let snapshotOutbox!: () => void;
      const outboxSnapshotReady = new Promise<void>((resolve) => {
        snapshotOutbox = resolve;
      });
      const outboxRelease = new Promise<void>((resolve) => {
        releaseOutbox = resolve;
      });
      const snapshotEvent = {
        tenantId: tenant.id,
        aggregateType: 'Bill',
        aggregateId: 'future-bill',
        eventType: 'BILL_PUBLISHED',
        dedupKey: 'future-bill:published',
        payload: { billId: 'future-bill' },
        availableAt: new Date('2099-01-01T00:00:00.000Z'),
      };
      const winningEvent = await runWithTenant(tenant.id, () => outbox.enqueue(snapshotEvent));
      const staleEnqueue = prisma.raw.$transaction(async (transaction) => {
        await transaction.outboxEvent.findMany({ where: { tenantId: tenant.id } });
        snapshotOutbox();
        await outboxRelease;
        return runWithTenant(tenant.id, () => outbox.enqueue(snapshotEvent, transaction));
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      await outboxSnapshotReady;
      await prisma.raw.outboxEvent.update({
        where: { id: winningEvent.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      releaseOutbox();
      await expect(staleEnqueue).resolves.toMatchObject({
        id: winningEvent.id,
        status: 'PUBLISHED',
      });

      const outboxDuplicateBarrier = createBarrier(2);
      const duplicateEvents = await Promise.all(
        [1, 2].map(() =>
          prisma.raw.$transaction(
            async (transaction) => {
              await transaction.outboxEvent.findMany({ where: { tenantId: tenant.id } });
              await outboxDuplicateBarrier();
              return runWithTenant(tenant.id, () => outbox.enqueue(snapshotEvent, transaction));
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
          ),
        ),
      );
      expect(duplicateEvents).toEqual([
        expect.objectContaining({ id: winningEvent.id, status: 'PUBLISHED' }),
        expect.objectContaining({ id: winningEvent.id, status: 'PUBLISHED' }),
      ]);

      let timezoneUtcNow!: Date;
      const timezoneEvent = await prisma.raw.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe("SET time_zone = '+08:00'");
        try {
          const [clock] = await transaction.$queryRaw<
            Array<{ currentNow: Date; utcNow: Date }>
          >`
            SELECT CURRENT_TIMESTAMP(3) AS \`currentNow\`, UTC_TIMESTAMP(3) AS \`utcNow\`
          `;
          expect(clock.currentNow.getTime() - clock.utcNow.getTime()).toBe(8 * 60 * 60 * 1000);
          timezoneUtcNow = clock.utcNow;
          return await runWithTenant(tenant.id, () =>
            outbox.enqueue(
              {
                tenantId: tenant.id,
                aggregateType: 'Bill',
                aggregateId: 'timezone-bill',
                eventType: 'BILL_PUBLISHED',
                dedupKey: 'timezone-bill:published',
                payload: { billId: 'timezone-bill' },
              },
              transaction,
            ),
          );
        } finally {
          await transaction.$executeRawUnsafe("SET time_zone = '+00:00'");
        }
      });
      expect(Math.abs(timezoneEvent.availableAt.getTime() - timezoneUtcNow.getTime())).toBeLessThan(
        1000,
      );
      const [timezoneClaim] = await outbox.claimBatch({
        tenantId: tenant.id,
        workerId: 'timezone-worker',
        limit: 1,
        leaseMs: 30_000,
      });
      expect(timezoneClaim.id).toBe(timezoneEvent.id);
      await outbox.markPublished({
        tenantId: tenant.id,
        eventId: timezoneClaim.id,
        workerId: timezoneClaim.claimOwner!,
        claimExpiresAt: timezoneClaim.claimExpiresAt!,
      });

      for (let index = 1; index <= 4; index += 1) {
        await runWithTenant(tenant.id, () =>
          outbox.enqueue({
            tenantId: tenant.id,
            aggregateType: 'Bill',
            aggregateId: `due-bill-${index}`,
            eventType: 'BILL_PUBLISHED',
            dedupKey: `due-bill-${index}:published`,
            payload: { billId: `due-bill-${index}` },
          }),
        );
      }
      const [claimWindowStart] = await prisma.raw.$queryRaw<Array<{ dbNow: Date }>>`
        SELECT UTC_TIMESTAMP(3) AS \`dbNow\`
      `;
      const [workerA, workerB] = await Promise.all([
        outbox.claimBatch({
          tenantId: tenant.id,
          workerId: 'mysql-worker-a',
          limit: 2,
          leaseMs: 30_000,
        }),
        outbox.claimBatch({
          tenantId: tenant.id,
          workerId: 'mysql-worker-b',
          limit: 2,
          leaseMs: 30_000,
        }),
      ]);
      const [claimWindowEnd] = await prisma.raw.$queryRaw<Array<{ dbNow: Date }>>`
        SELECT UTC_TIMESTAMP(3) AS \`dbNow\`
      `;
      const claimed = [...workerA, ...workerB];
      expect(claimed).toHaveLength(4);
      expect(new Set(claimed.map((event) => event.id)).size).toBe(4);
      expect(new Set(claimed.map((event) => event.claimOwner))).toEqual(
        new Set(['mysql-worker-a', 'mysql-worker-b']),
      );
      for (const event of claimed) {
        expect(event.claimExpiresAt!.getTime() - event.lastAttemptAt!.getTime()).toBe(30_000);
        expect(event.lastAttemptAt!.getTime()).toBeGreaterThanOrEqual(
          claimWindowStart.dbNow.getTime(),
        );
        expect(event.lastAttemptAt!.getTime()).toBeLessThanOrEqual(claimWindowEnd.dbNow.getTime());
      }

      const oldLease = claimed[0];
      const wrongCaseWorker = oldLease.claimOwner!.toUpperCase();
      expect(wrongCaseWorker).not.toBe(oldLease.claimOwner);
      await expect(
        outbox.markPublished({
          tenantId: tenant.id,
          eventId: oldLease.id,
          workerId: wrongCaseWorker,
          claimExpiresAt: oldLease.claimExpiresAt!,
        }),
      ).rejects.toMatchObject({ code: 40000 });
      await expect(
        outbox.markFailed({
          tenantId: tenant.id,
          eventId: oldLease.id,
          workerId: wrongCaseWorker,
          claimExpiresAt: oldLease.claimExpiresAt!,
          error: 'wrong owner',
        }),
      ).rejects.toMatchObject({ code: 40000 });
      await prisma.raw.outboxEvent.update({
        where: { id: oldLease.id },
        data: { claimExpiresAt: new Date('2000-01-01T00:00:00.000Z') },
      });
      const [renewedLease] = await outbox.claimBatch({
        tenantId: tenant.id,
        workerId: oldLease.claimOwner!,
        limit: 1,
        leaseMs: 30_000,
      });
      expect(renewedLease.id).toBe(oldLease.id);
      await expect(
        outbox.markPublished({
          tenantId: tenant.id,
          eventId: oldLease.id,
          workerId: oldLease.claimOwner!,
          claimExpiresAt: oldLease.claimExpiresAt!,
        }),
      ).rejects.toMatchObject({ code: 40000 });
      await expect(
        outbox.markPublished({
          tenantId: tenant.id,
          eventId: renewedLease.id,
          workerId: renewedLease.claimOwner!,
          claimExpiresAt: renewedLease.claimExpiresAt!,
        }),
      ).resolves.toBeUndefined();

      const failedLease = claimed.find((event) => event.id !== oldLease.id)!;
      const [failureWindowStart] = await prisma.raw.$queryRaw<Array<{ dbNow: Date }>>`
        SELECT UTC_TIMESTAMP(3) AS \`dbNow\`
      `;
      await outbox.markFailed({
        tenantId: tenant.id,
        eventId: failedLease.id,
        workerId: failedLease.claimOwner!,
        claimExpiresAt: failedLease.claimExpiresAt!,
        error: 'token=provider-secret phone 13800138000',
        baseBackoffMs: 1000,
      });
      const [failureWindowEnd] = await prisma.raw.$queryRaw<Array<{ dbNow: Date }>>`
        SELECT UTC_TIMESTAMP(3) AS \`dbNow\`
      `;
      const failedEvent = await prisma.raw.outboxEvent.findUniqueOrThrow({
        where: { id: failedLease.id },
      });
      expect(failedEvent.status).toBe('FAILED');
      expect(failedEvent.availableAt.getTime()).toBeGreaterThanOrEqual(
        failureWindowStart.dbNow.getTime() + 1000,
      );
      expect(failedEvent.availableAt.getTime()).toBeLessThanOrEqual(
        failureWindowEnd.dbNow.getTime() + 1000,
      );
      expect(failedEvent.lastError).not.toContain('provider-secret');
      expect(failedEvent.lastError).not.toContain('13800138000');
    } finally {
      if (app) await app.close();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      await dropDatabase(database.name);
    }
  });

  it('serves a guarded tenant-isolated read-only admin endpoint with unchanged super-admin scope', async () => {
    const database = await createDatabase('endpoint');
    const previousDatabaseUrl = process.env.DATABASE_URL;
    let app: INestApplication | undefined;
    try {
      applyMigration(database.url, auditGuardMigrationFile);
      process.env.DATABASE_URL = database.url;
      app = await createTestApp();
      const prisma = app.get(PrismaService);
      const passwordHash = await bcrypt.hash('pass123', 4);
      const [tenantA, tenantB] = await Promise.all([
        prisma.raw.tenant.create({
          data: { id: 'endpoint-tenant-a', name: 'Endpoint A', code: 'endpoint-a' },
        }),
        prisma.raw.tenant.create({
          data: { id: 'endpoint-tenant-b', name: 'Endpoint B', code: 'endpoint-b' },
        }),
      ]);
      const [adminA, adminB, superAdmin] = await Promise.all([
        prisma.raw.adminUser.create({
          data: {
            tenantId: tenantA.id,
            username: 'endpoint-admin-a',
            passwordHash,
            name: 'Admin A',
            role: 'TENANT_ADMIN',
          },
        }),
        prisma.raw.adminUser.create({
          data: {
            tenantId: tenantB.id,
            username: 'endpoint-admin-b',
            passwordHash,
            name: 'Admin B',
            role: 'TENANT_ADMIN',
          },
        }),
        prisma.raw.adminUser.create({
          data: {
            username: 'endpoint-super',
            passwordHash,
            name: 'Super Admin',
            role: 'SUPER_ADMIN',
          },
        }),
      ]);
      await Promise.all([
        prisma.raw.auditLog.create({
          data: {
            id: 'endpoint-audit-a',
            tenantId: tenantA.id,
            actorType: 'ADMIN',
            actorId: adminA.id,
            action: 'UPDATE',
            resourceType: 'Bill',
            resourceId: 'endpoint-bill-a',
            beforeSummary: { amount: 100, password: 'legacy-password' },
            afterSummary: { amount: 200, phone: '13800138000' },
          },
        }),
        prisma.raw.auditLog.create({
          data: {
            id: 'endpoint-audit-b',
            tenantId: tenantB.id,
            actorType: 'ADMIN',
            actorId: adminB.id,
            action: 'UPDATE',
            resourceType: 'Bill',
            resourceId: 'endpoint-bill-b',
          },
        }),
      ]);

      async function login(username: string): Promise<string> {
        const response = await request(app!.getHttpServer())
          .post('/api/v1/admin/auth/login')
          .send({ username, password: 'pass123' })
          .expect(200);
        expect(response.body.code).toBe(0);
        return response.body.data.token as string;
      }

      const [tokenA, superToken] = await Promise.all([
        login('endpoint-admin-a'),
        login(superAdmin.username),
      ]);
      const tenantResult = await request(app.getHttpServer())
        .get(
          '/api/v1/admin/audit-logs?action=UPDATE&resourceType=Bill&from=2020-01-01T00:00:00.000Z&to=2035-01-01T00:00:00.000Z',
        )
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(tenantResult.body.code).toBe(0);
      expect(tenantResult.body.data.list.map((row: { id: string }) => row.id)).toEqual([
        'endpoint-audit-a',
      ]);
      expect(JSON.stringify(tenantResult.body)).not.toContain('legacy-password');
      expect(JSON.stringify(tenantResult.body)).not.toContain('13800138000');

      const platformResult = await request(app.getHttpServer())
        .get('/api/v1/admin/audit-logs')
        .set('Authorization', `Bearer ${superToken}`)
        .expect(200);
      expect(new Set(platformResult.body.data.list.map((row: { id: string }) => row.id))).toEqual(
        new Set(['endpoint-audit-a', 'endpoint-audit-b']),
      );

      const scopedResult = await request(app.getHttpServer())
        .get('/api/v1/admin/audit-logs')
        .set('Authorization', `Bearer ${superToken}`)
        .set('X-Tenant-Id', tenantB.id)
        .expect(200);
      expect(scopedResult.body.data.list.map((row: { id: string }) => row.id)).toEqual([
        'endpoint-audit-b',
      ]);

      const mutationResult = await request(app.getHttpServer())
        .post('/api/v1/admin/audit-logs')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ resourceId: 'tampered' })
        .expect(200);
      expect(mutationResult.body.code).toBe(40400);
    } finally {
      if (app) await app.close();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      await dropDatabase(database.name);
    }
  });
});
