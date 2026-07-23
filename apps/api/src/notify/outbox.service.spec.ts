import { MODULE_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';
import { NotifyModule } from './notify.module';
import { NotifyService } from './notify.service';
import { OutboxService } from './outbox.service';

type OutboxStatus = 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED';
type StoredEvent = {
  id: string;
  tenantId: string;
  communityId?: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  dedupKey: string;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  availableAt: Date;
  claimOwner?: string | null;
  claimExpiresAt?: Date | null;
  lastAttemptAt?: Date | null;
  publishedAt?: Date | null;
  lastError?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function isDate(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === '[object Date]';
}

function compare(value: unknown, condition: unknown): boolean {
  if (condition === null || typeof condition !== 'object' || isDate(condition)) {
    return value === condition ||
      (isDate(value) && isDate(condition) && value.getTime() === condition.getTime());
  }
  const rule = condition as Record<string, unknown>;
  if ('in' in rule && !(rule.in as unknown[]).includes(value)) return false;
  if ('notIn' in rule && (rule.notIn as unknown[]).includes(value)) return false;
  if ('lt' in rule && !((value as number) < (rule.lt as number))) return false;
  if ('gte' in rule && !((value as number) >= (rule.gte as number))) return false;
  if ('equals' in rule && !compare(value, rule.equals)) return false;
  if ('lte' in rule) {
    const left = isDate(value) ? value.getTime() : (value as number);
    const right = isDate(rule.lte) ? rule.lte.getTime() : (rule.lte as number);
    if (!(left <= right)) return false;
  }
  if ('gt' in rule) {
    const left = isDate(value) ? value.getTime() : (value as number);
    const right = isDate(rule.gt) ? rule.gt.getTime() : (rule.gt as number);
    if (!(left > right)) return false;
  }
  return true;
}

function matches(record: StoredEvent, where: Record<string, unknown> = {}): boolean {
  if (where.AND && !(where.AND as Record<string, unknown>[]).every((part) => matches(record, part))) {
    return false;
  }
  if (where.OR && !(where.OR as Record<string, unknown>[]).some((part) => matches(record, part))) {
    return false;
  }
  if (where.NOT && matches(record, where.NOT as Record<string, unknown>)) return false;
  for (const [key, condition] of Object.entries(where)) {
    if (['AND', 'OR', 'NOT'].includes(key)) continue;
    if (!compare(record[key as keyof StoredEvent], condition)) return false;
  }
  return true;
}

class MemoryOutboxDb {
  readonly events = new Map<string, StoredEvent>();
  readonly executedSql: string[] = [];
  private databaseNowOverride?: Date;
  private readonly lockedIds = new Set<string>();
  private sequence = 0;

  get databaseNow(): Date {
    return this.databaseNowOverride
      ? new Date(this.databaseNowOverride.getTime())
      : new Date();
  }

  set databaseNow(value: Date) {
    this.databaseNowOverride = new Date(value.getTime());
  }

  seed(input: Partial<StoredEvent> & Pick<StoredEvent, 'id' | 'tenantId' | 'dedupKey'>): StoredEvent {
    const now = new Date();
    const event: StoredEvent = {
      aggregateType: 'Bill',
      aggregateId: input.id,
      eventType: 'BILL_PUBLISHED',
      payload: {},
      status: 'PENDING',
      attempts: 0,
      availableAt: now,
      claimOwner: null,
      claimExpiresAt: null,
      lastAttemptAt: null,
      publishedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.events.set(event.id, event);
    return event;
  }

  readonly outboxEvent = {
    findUnique: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.id) return structuredClone(this.events.get(where.id as string) ?? null);
      const composite = where.tenantId_dedupKey as
        | { tenantId: string; dedupKey: string }
        | undefined;
      if (!composite) return null;
      return structuredClone(
        [...this.events.values()].find(
          (event) =>
            event.tenantId === composite.tenantId && event.dedupKey === composite.dedupKey,
        ) ?? null,
      );
    }),
    findFirst: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        structuredClone([...this.events.values()].find((event) => matches(event, where)) ?? null),
    ),
    findMany: jest.fn(
      async ({
        where,
        take,
      }: {
        where: Record<string, unknown>;
        take?: number;
      }) =>
        [...this.events.values()]
          .filter((event) => matches(event, where))
          .sort(
            (a, b) =>
              a.availableAt.getTime() - b.availableAt.getTime() ||
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.id.localeCompare(b.id),
          )
          .slice(0, take)
          .map((event) => structuredClone(event)),
    ),
    create: jest.fn(async ({ data }: { data: Partial<StoredEvent> }) => {
      const duplicate = [...this.events.values()].some(
        (event) => event.tenantId === data.tenantId && event.dedupKey === data.dedupKey,
      );
      if (duplicate) {
        throw new Prisma.PrismaClientKnownRequestError('duplicate outbox key', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      this.sequence += 1;
      return structuredClone(
        this.seed({
          ...(data as Omit<StoredEvent, 'id' | 'createdAt' | 'updatedAt'>),
          id: `event-${this.sequence}`,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
    }),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const candidates = [...this.events.values()].filter((event) => matches(event, where));
        for (const event of candidates) {
          for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === 'object' && 'increment' in value) {
              (event as unknown as Record<string, unknown>)[key] =
                ((event as unknown as Record<string, number>)[key] ?? 0) +
                ((value as { increment: number }).increment ?? 0);
            } else {
              (event as unknown as Record<string, unknown>)[key] = structuredClone(value);
            }
          }
          event.updatedAt = new Date();
        }
        return { count: candidates.length };
      },
    ),
  };

  private executeQuery(
    query: Prisma.Sql,
    transactionLocks: Set<string>,
  ): Array<Record<string, unknown>> {
    const sql = (query as unknown as { strings: string[] }).strings.join('?');
    this.executedSql.push(sql);
    const values = query.values as unknown[];
    const dbNow = this.databaseNow;
    if (sql.includes('SELECT UTC_TIMESTAMP(3)') && !sql.includes('FROM `OutboxEvent`')) {
      return [{ dbNow }];
    }
    if (sql.includes('SELECT *') && sql.includes('FOR SHARE')) {
      const [tenantId, dedupKey] = values as [string, string];
      const event = [...this.events.values()].find(
        (candidate) => candidate.tenantId === tenantId && candidate.dedupKey === dedupKey,
      );
      return event ? [structuredClone(event) as unknown as Record<string, unknown>] : [];
    }
    if (sql.includes('SELECT `attempts`')) {
      const [eventId, tenantId, workerId, claimExpiresAt] = values as [
        string,
        string,
        string,
        Date,
      ];
      const event = this.events.get(eventId);
      const ownsLease =
        event?.tenantId === tenantId &&
        event.status === 'PROCESSING' &&
        event.claimOwner === workerId &&
        isDate(event.claimExpiresAt) &&
        event.claimExpiresAt.getTime() === claimExpiresAt.getTime() &&
        event.claimExpiresAt.getTime() > dbNow.getTime() &&
        !this.lockedIds.has(event.id);
      if (!event || !ownsLease) return [];
      this.lockedIds.add(event.id);
      transactionLocks.add(event.id);
      return [{ attempts: event.attempts, dbNow }];
    }

    const [tenantId, maxAttempts, limit] = values as [string, number, number];
    const candidates = [...this.events.values()]
      .filter(
        (event) =>
          event.tenantId === tenantId &&
          event.attempts < maxAttempts &&
          !this.lockedIds.has(event.id) &&
          (((event.status === 'PENDING' || event.status === 'FAILED') &&
            event.availableAt.getTime() <= dbNow.getTime()) ||
            (event.status === 'PROCESSING' &&
              isDate(event.claimExpiresAt) &&
              event.claimExpiresAt.getTime() <= dbNow.getTime())),
      )
      .sort(
        (a, b) =>
          a.availableAt.getTime() - b.availableAt.getTime() ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      )
      .slice(0, limit);
    for (const event of candidates) {
      this.lockedIds.add(event.id);
      transactionLocks.add(event.id);
    }
    return candidates.map(({ id }) => ({ id }));
  }

  readonly $queryRaw = jest.fn(async (query: Prisma.Sql) =>
    this.executeQuery(query, new Set<string>()),
  );

  readonly $transaction = jest.fn(
    async <T>(
      callback: (tx: {
        outboxEvent: MemoryOutboxDb['outboxEvent'];
        $queryRaw: (query: Prisma.Sql) => Promise<Array<Record<string, unknown>>>;
      }) => Promise<T>,
    ) => {
      const transactionLocks = new Set<string>();
      const queryRaw = jest.fn(async (query: Prisma.Sql) =>
        this.executeQuery(query, transactionLocks),
      );
      try {
        return await callback({ outboxEvent: this.outboxEvent, $queryRaw: queryRaw });
      } finally {
        for (const id of transactionLocks) this.lockedIds.delete(id);
      }
    },
  );
}

const enqueueInput = {
  tenantId: 'tenant-1',
  communityId: 'community-1',
  aggregateType: 'Bill',
  aggregateId: 'bill-1',
  eventType: 'BILL_PUBLISHED',
  dedupKey: 'bill-1:published',
  payload: { billId: 'bill-1' },
};

function createHarness(db = new MemoryOutboxDb()) {
  const prisma = {
    t: { outboxEvent: db.outboxEvent },
    raw: db,
  } as unknown as PrismaService;
  return { service: new OutboxService(prisma), db, prisma };
}

describe('OutboxService wiring', () => {
  it('is registered and exported by NotifyModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, NotifyModule)).toEqual(
      expect.arrayContaining([OutboxService]),
    );
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, NotifyModule)).toEqual(
      expect.arrayContaining([OutboxService]),
    );
  });
});

describe('OutboxService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('enqueues once through a caller transaction and redacts sensitive payload values', async () => {
    const defaultHarness = createHarness();
    const transactionDb = new MemoryOutboxDb();
    transactionDb.databaseNow = new Date('2030-01-01T00:00:00.000Z');
    const input = {
      ...enqueueInput,
      payload: {
        billId: 'bill-1',
        token: 'payload-token',
        nested: { phone: '13800138000', openid: 'openid-secret' },
      },
    };

    const first = await runWithTenant('tenant-1', () =>
      defaultHarness.service.enqueue(input, transactionDb as never),
    );
    const replay = await runWithTenant('tenant-1', () =>
      defaultHarness.service.enqueue(input, transactionDb as never),
    );

    expect(replay.id).toBe(first.id);
    expect(transactionDb.events.size).toBe(1);
    expect(defaultHarness.db.events.size).toBe(0);
    const serialized = JSON.stringify([...transactionDb.events.values()]);
    expect(serialized).toContain('bill-1');
    expect(serialized).not.toContain('payload-token');
    expect(serialized).not.toContain('13800138000');
    expect(serialized).not.toContain('openid-secret');
    const createData = transactionDb.outboxEvent.create.mock.calls[0][0].data;
    expect(createData.availableAt).toEqual(new Date('2030-01-01T00:00:00.000Z'));
  });

  it('rejects reuse of a tenant dedup key for a different event', async () => {
    const { service } = createHarness();
    await runWithTenant('tenant-1', () => service.enqueue(enqueueInput));

    await expect(
      runWithTenant('tenant-1', () =>
        service.enqueue({
          ...enqueueInput,
          aggregateId: 'bill-2',
          payload: { billId: 'bill-2' },
        }),
      ),
    ).rejects.toMatchObject({ code: 40000 });
  });

  it('uses a non-mutating current read after P2002 in a caller transaction', async () => {
    const { service } = createHarness();
    const existing = new MemoryOutboxDb().seed({
      id: 'existing-event',
      tenantId: 'tenant-1',
      dedupKey: enqueueInput.dedupKey,
      communityId: enqueueInput.communityId,
      aggregateType: enqueueInput.aggregateType,
      aggregateId: enqueueInput.aggregateId,
      eventType: enqueueInput.eventType,
      payload: enqueueInput.payload,
    });
    const current = {
      ...existing,
      status: 'PUBLISHED' as const,
      publishedAt: new Date(),
      updatedAt: new Date(existing.updatedAt.getTime() + 1),
    };
    const transaction = {
      outboxEvent: {
        findUnique: jest.fn(async () => existing),
        create: jest.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError('duplicate outbox key', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }),
        updateMany: jest.fn(async () => {
          throw new Error('P2002 recovery must not mutate the existing event');
        }),
      },
      $queryRaw: jest.fn(async (query: Prisma.Sql) => {
        const sql = (query as unknown as { strings: string[] }).strings.join('?');
        return sql.includes('SELECT UTC_TIMESTAMP(3)')
          ? [{ dbNow: new Date('2030-01-01T00:00:00.000Z') }]
          : [current];
      }),
    };

    await expect(
      runWithTenant('tenant-1', () => service.enqueue(enqueueInput, transaction as never)),
    ).resolves.toMatchObject({ id: 'existing-event', status: 'PUBLISHED' });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(transaction.outboxEvent.updateMany).not.toHaveBeenCalled();
  });

  it('rejects enqueue through a caller transaction without tenant context', async () => {
    const { service } = createHarness();
    const transactionDb = new MemoryOutboxDb();

    await expect(service.enqueue(enqueueInput, transactionDb as never)).rejects.toMatchObject({
      code: 40300,
    });
    expect(transactionDb.events.size).toBe(0);
  });

  it('atomically splits due events between concurrent workers without duplicate claims', async () => {
    const { service, db } = createHarness();
    for (let index = 1; index <= 4; index += 1) {
      db.seed({ id: `due-${index}`, tenantId: 'tenant-1', dedupKey: `due-${index}` });
    }

    const [workerA, workerB] = await Promise.all([
      service.claimBatch({
        tenantId: 'tenant-1',
        workerId: 'worker-a',
        limit: 2,
        leaseMs: 30_000,
      }),
      service.claimBatch({
        tenantId: 'tenant-1',
        workerId: 'worker-b',
        limit: 2,
        leaseMs: 30_000,
      }),
    ]);

    const claimed = [...workerA, ...workerB];
    expect(claimed).toHaveLength(4);
    expect(new Set(claimed.map((event) => event.id)).size).toBe(4);
    expect(new Set(claimed.map((event) => event.claimOwner))).toEqual(
      new Set(['worker-a', 'worker-b']),
    );
    expect(claimed.every((event) => event.status === 'PROCESSING')).toBe(true);
    expect(claimed.every((event) => event.attempts === 1)).toBe(true);
  });

  it('uses the database clock for eligibility and the returned lease deadline', async () => {
    const { service, db } = createHarness();
    db.databaseNow = new Date('2030-01-01T00:00:00.000Z');
    db.seed({
      id: 'database-clock-event',
      tenantId: 'tenant-1',
      dedupKey: 'database-clock-event',
      availableAt: new Date('2029-12-31T23:59:59.000Z'),
    });

    const [claimed] = await service.claimBatch({
      tenantId: 'tenant-1',
      workerId: 'worker-a',
      limit: 1,
      leaseMs: 1000,
    });

    expect(claimed.id).toBe('database-clock-event');
    expect(claimed.lastAttemptAt).toEqual(new Date('2030-01-01T00:00:00.000Z'));
    expect(claimed.claimExpiresAt).toEqual(new Date('2030-01-01T00:00:01.000Z'));
  });

  it('locks claim candidates in deterministic due order with skip-locked semantics', async () => {
    const { service, db } = createHarness();
    db.seed({ id: 'ordered', tenantId: 'tenant-1', dedupKey: 'ordered' });

    await service.claimBatch({ tenantId: 'tenant-1', workerId: 'worker-a', limit: 1 });

    const claimSql = db.executedSql.find(
      (sql) => sql.includes('SELECT `id`') && sql.includes('FOR UPDATE SKIP LOCKED'),
    );
    expect(claimSql).toContain('ORDER BY `availableAt`, `createdAt`, `id`');
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('claims only due PENDING/FAILED and expired PROCESSING rows below max attempts', async () => {
    const { service, db } = createHarness();
    const now = new Date();
    db.seed({ id: 'pending-due', tenantId: 'tenant-1', dedupKey: 'pending-due' });
    db.seed({
      id: 'failed-due',
      tenantId: 'tenant-1',
      dedupKey: 'failed-due',
      status: 'FAILED',
      attempts: 1,
    });
    db.seed({
      id: 'lease-expired',
      tenantId: 'tenant-1',
      dedupKey: 'lease-expired',
      status: 'PROCESSING',
      attempts: 1,
      claimOwner: 'dead-worker',
      claimExpiresAt: new Date(now.getTime() - 1),
    });
    db.seed({
      id: 'pending-future',
      tenantId: 'tenant-1',
      dedupKey: 'pending-future',
      availableAt: new Date(now.getTime() + 1),
    });
    db.seed({
      id: 'lease-active',
      tenantId: 'tenant-1',
      dedupKey: 'lease-active',
      status: 'PROCESSING',
      claimOwner: 'live-worker',
      claimExpiresAt: new Date(now.getTime() + 1),
    });
    db.seed({
      id: 'failed-maxed',
      tenantId: 'tenant-1',
      dedupKey: 'failed-maxed',
      status: 'FAILED',
      attempts: 5,
    });
    db.seed({
      id: 'published',
      tenantId: 'tenant-1',
      dedupKey: 'published',
      status: 'PUBLISHED',
    });
    db.seed({ id: 'other-tenant', tenantId: 'tenant-2', dedupKey: 'other-tenant' });

    const claimed = await service.claimBatch({
      tenantId: 'tenant-1',
      workerId: 'worker-a',
      limit: 10,
      leaseMs: 30_000,
    });

    expect(new Set(claimed.map((event: StoredEvent) => event.id))).toEqual(
      new Set(['pending-due', 'failed-due', 'lease-expired']),
    );
  });

  it('moves an expired final attempt to terminal FAILED instead of stranding PROCESSING', async () => {
    const { service, db } = createHarness();
    db.seed({
      id: 'crashed-final-attempt',
      tenantId: 'tenant-1',
      dedupKey: 'crashed-final-attempt',
      status: 'PROCESSING',
      attempts: 5,
      claimOwner: 'dead-worker',
      claimExpiresAt: new Date(Date.now() - 1),
    });

    await expect(
      service.claimBatch({
        tenantId: 'tenant-1',
        workerId: 'worker-a',
        limit: 1,
        leaseMs: 1000,
      }),
    ).resolves.toEqual([]);
    expect(db.events.get('crashed-final-attempt')).toMatchObject({
      status: 'FAILED',
      claimOwner: null,
      claimExpiresAt: null,
      availableAt: new Date('9999-12-31T23:59:59.999Z'),
    });

    jest.advanceTimersByTime(60_000);
    await expect(
      service.claimBatch({
        tenantId: 'tenant-1',
        workerId: 'worker-b',
        limit: 1,
        leaseMs: 1000,
      }),
    ).resolves.toEqual([]);
  });

  it('publishes only with the matching unexpired lease owner', async () => {
    const { service, db } = createHarness();
    db.seed({ id: 'publish-me', tenantId: 'tenant-1', dedupKey: 'publish-me' });
    const [claimed] = await service.claimBatch({
      tenantId: 'tenant-1',
      workerId: 'worker-a',
      limit: 1,
      leaseMs: 1000,
    });

    await expect(
      service.markPublished({
        tenantId: 'tenant-1',
        eventId: claimed.id,
        workerId: 'worker-b',
        claimExpiresAt: claimed.claimExpiresAt!,
      }),
    ).rejects.toMatchObject({ code: 40000 });
    expect(db.events.get(claimed.id)?.status).toBe('PROCESSING');

    await service.markPublished({
      tenantId: 'tenant-1',
      eventId: claimed.id,
      workerId: 'worker-a',
      claimExpiresAt: claimed.claimExpiresAt!,
    });
    expect(db.events.get(claimed.id)).toMatchObject({
      status: 'PUBLISHED',
      claimOwner: null,
      claimExpiresAt: null,
      publishedAt: new Date(),
    });

    db.seed({ id: 'expired-publish', tenantId: 'tenant-1', dedupKey: 'expired-publish' });
    const [expired] = await service.claimBatch({
      tenantId: 'tenant-1',
      workerId: 'worker-a',
      limit: 1,
      leaseMs: 1000,
    });
    jest.advanceTimersByTime(1001);
    await expect(
      service.markPublished({
        tenantId: 'tenant-1',
        eventId: expired.id,
        workerId: 'worker-a',
        claimExpiresAt: expired.claimExpiresAt!,
      }),
    ).rejects.toMatchObject({ code: 40000 });
  });

  it('does not let an old execution borrow a renewed lease owned by the same worker ID', async () => {
    const { service, db } = createHarness();
    db.seed({ id: 'same-worker-reclaim', tenantId: 'tenant-1', dedupKey: 'same-worker-reclaim' });
    const [firstClaim] = await service.claimBatch({
      tenantId: 'tenant-1',
      workerId: 'worker-a',
      limit: 1,
      leaseMs: 1000,
    });
    const oldClaimExpiresAt = firstClaim.claimExpiresAt!;
    jest.advanceTimersByTime(1001);
    const [secondClaim] = await service.claimBatch({
      tenantId: 'tenant-1',
      workerId: 'worker-a',
      limit: 1,
      leaseMs: 1000,
    });
    expect(secondClaim.claimExpiresAt!.getTime()).not.toBe(oldClaimExpiresAt.getTime());
    expect(db.events.get(firstClaim.id)?.claimExpiresAt).toEqual(secondClaim.claimExpiresAt);
    expect(compare(secondClaim.claimExpiresAt, oldClaimExpiresAt)).toBe(false);
    expect(
      matches(db.events.get(firstClaim.id)!, {
        claimExpiresAt: { equals: oldClaimExpiresAt, gt: new Date() },
      }),
    ).toBe(false);

    await expect(
      service.markPublished({
        tenantId: 'tenant-1',
        eventId: firstClaim.id,
        workerId: 'worker-a',
        claimExpiresAt: oldClaimExpiresAt,
      }),
    ).rejects.toMatchObject({ code: 40000 });
    await expect(
      service.markPublished({
        tenantId: 'tenant-1',
        eventId: secondClaim.id,
        workerId: 'worker-a',
        claimExpiresAt: secondClaim.claimExpiresAt!,
      }),
    ).resolves.toBeUndefined();
  });

  it('redacts and truncates failures, applies exponential backoff, and stops at max attempts', async () => {
    const { service, db } = createHarness();
    db.seed({ id: 'retry-me', tenantId: 'tenant-1', dedupKey: 'retry-me' });
    let [claimed] = await service.claimBatch({
      tenantId: 'tenant-1',
      workerId: 'worker-a',
      limit: 1,
      leaseMs: 30_000,
    });

    await service.markFailed({
      tenantId: 'tenant-1',
      eventId: claimed.id,
      workerId: 'worker-a',
      claimExpiresAt: claimed.claimExpiresAt!,
      error: `Bearer provider-token apiV3Key=plain-api-secret token:plain-token phone 13800138000 ${'x'.repeat(400)}`,
      baseBackoffMs: 1000,
    });
    const firstFailure = db.events.get(claimed.id)!;
    expect(firstFailure.status).toBe('FAILED');
    expect(firstFailure.availableAt).toEqual(new Date('2026-07-22T00:00:01.000Z'));
    expect(firstFailure.lastError?.length).toBeLessThanOrEqual(191);
    expect(firstFailure.lastError).not.toContain('provider-token');
    expect(firstFailure.lastError).not.toContain('plain-api-secret');
    expect(firstFailure.lastError).not.toContain('plain-token');
    expect(firstFailure.lastError).not.toContain('13800138000');
    firstFailure.attempts = 4;

    expect(
      await service.claimBatch({
        tenantId: 'tenant-1',
        workerId: 'worker-a',
        limit: 1,
        leaseMs: 30_000,
      }),
    ).toEqual([]);

    jest.advanceTimersByTime(1000);
    [claimed] = await service.claimBatch({
      tenantId: 'tenant-1',
      workerId: 'worker-a',
      limit: 1,
      leaseMs: 30_000,
    });
    expect(claimed.attempts).toBe(5);
    await service.markFailed({
      tenantId: 'tenant-1',
      eventId: claimed.id,
      workerId: 'worker-a',
      claimExpiresAt: claimed.claimExpiresAt!,
      error: 'terminal failure',
      baseBackoffMs: 1000,
    });

    jest.advanceTimersByTime(60_000);
    expect(
      await service.claimBatch({
        tenantId: 'tenant-1',
        workerId: 'worker-b',
        limit: 1,
        leaseMs: 30_000,
      }),
    ).toEqual([]);
    expect(db.events.get(claimed.id)).toMatchObject({ status: 'FAILED', attempts: 5 });
  });

  it.each([
    { attempts: 1, expectedDelay: 1000 },
    { attempts: 2, expectedDelay: 2000 },
    { attempts: 3, expectedDelay: 2500 },
    { attempts: 4, expectedDelay: 2500 },
  ])(
    'backs off attempt $attempts by $expectedDelay ms without sleeping',
    async ({ attempts, expectedDelay }) => {
      const { service, db } = createHarness();
      const claimExpiresAt = new Date('2026-07-22T00:01:00.000Z');
      db.seed({
        id: `backoff-${attempts}`,
        tenantId: 'tenant-1',
        dedupKey: `backoff-${attempts}`,
        status: 'PROCESSING',
        attempts,
        claimOwner: 'worker-a',
        claimExpiresAt,
      });

      await service.markFailed({
        tenantId: 'tenant-1',
        eventId: `backoff-${attempts}`,
        workerId: 'worker-a',
        claimExpiresAt,
        error: 'retryable',
        baseBackoffMs: 1000,
        maxBackoffMs: 2500,
      });

      expect(db.events.get(`backoff-${attempts}`)?.availableAt).toEqual(
        new Date(Date.now() + expectedDelay),
      );
    },
  );

  it('rejects tenant spoofing for enqueue and lease completion', async () => {
    const { service, db } = createHarness();
    await expect(
      runWithTenant('tenant-2', () => service.enqueue(enqueueInput)),
    ).rejects.toMatchObject({ code: 40300 });
    expect(db.events.size).toBe(0);

    db.seed({
      id: 'tenant-1-event',
      tenantId: 'tenant-1',
      dedupKey: 'tenant-1-event',
      status: 'PROCESSING',
      claimOwner: 'worker-a',
      claimExpiresAt: new Date(Date.now() + 1000),
    });
    await expect(
      runWithTenant('tenant-2', () =>
        service.markPublished({
          tenantId: 'tenant-1',
          eventId: 'tenant-1-event',
          workerId: 'worker-a',
          claimExpiresAt: db.events.get('tenant-1-event')!.claimExpiresAt!,
        }),
      ),
    ).rejects.toMatchObject({ code: 40300 });
  });
});

describe('NotifyService Outbox 投递适配器', () => {
  function makeDeliverer(overrides: {
    bindings?: Array<{ wxUser: { openid: string } }>;
    wxUser?: { openid: string } | null;
    sendSubscribeMessage?: jest.Mock;
  } = {}) {
    const wx = {
      sendSubscribeMessage: overrides.sendSubscribeMessage ?? jest.fn().mockResolvedValue({ ok: true }),
    };
    const outbox = {
      claimBatch: jest.fn(),
      markPublished: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      raw: {
        houseBinding: { findMany: jest.fn().mockResolvedValue(overrides.bindings ?? []) },
        wxUser: { findUnique: jest.fn().mockResolvedValue(overrides.wxUser ?? null) },
        outboxEvent: { findMany: jest.fn().mockResolvedValue([]) },
      },
    };
    const service = new NotifyService(prisma as never, wx as never, outbox as never);
    return { service, wx, outbox, prisma };
  }

  it('无订阅模板的事件（如开票）跳过投递，不呼叫微信', async () => {
    const { service, wx } = makeDeliverer({ wxUser: { openid: 'openid-1' } });
    await expect(
      service.deliverOutboxEvent({
        id: 'e-1',
        tenantId: 'tenant-1',
        aggregateType: 'InvoiceApplication',
        eventType: 'invoice.submitted',
        payload: { wxUserId: 'wx-1' },
      }),
    ).resolves.toBe('SKIPPED');
    expect(wx.sendSubscribeMessage).not.toHaveBeenCalled();
  });

  it('账单发布事件按房屋 ACTIVE 绑定去重投递，成功返回 DELIVERED', async () => {
    const send = jest.fn().mockResolvedValue({ ok: true });
    const { service } = makeDeliverer({
      bindings: [{ wxUser: { openid: 'openid-1' } }, { wxUser: { openid: 'openid-1' } }, { wxUser: { openid: 'openid-2' } }],
      sendSubscribeMessage: send,
    });
    await expect(
      service.deliverOutboxEvent({
        id: 'e-2',
        tenantId: 'tenant-1',
        aggregateType: 'Bill',
        eventType: 'bill.published',
        payload: { billId: 'b-1', houseId: 'house-1', period: '2026-07', amount: '100.00' },
      }),
    ).resolves.toBe('DELIVERED');
    // 同一 openid 只发一次（唯一收件人/渠道投递）
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c) => c[0].openid).sort()).toEqual(['openid-1', 'openid-2']);
  });

  it('收件人未订阅（denied）时跳过，不重试', async () => {
    const send = jest.fn().mockResolvedValue({ ok: false, error: 'errcode 43101 user not subscribed' });
    const { service } = makeDeliverer({ bindings: [{ wxUser: { openid: 'openid-1' } }], sendSubscribeMessage: send });
    await expect(
      service.deliverOutboxEvent({
        id: 'e-3',
        tenantId: 'tenant-1',
        aggregateType: 'Bill',
        eventType: 'bill.published',
        payload: { houseId: 'house-1' },
      }),
    ).resolves.toBe('SKIPPED');
  });

  it('网络/暂时性错误返回 RETRY', async () => {
    const send = jest.fn().mockRejectedValue(new Error('网络超时'));
    const { service } = makeDeliverer({ bindings: [{ wxUser: { openid: 'openid-1' } }], sendSubscribeMessage: send });
    await expect(
      service.deliverOutboxEvent({
        id: 'e-4',
        tenantId: 'tenant-1',
        aggregateType: 'Bill',
        eventType: 'bill.published',
        payload: { houseId: 'house-1' },
      }),
    ).resolves.toBe('RETRY');
  });

  it('dispatchOutboxBatch 领取后：投递成功 markPublished、可重试 markFailed', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('网络超时'));
    const { service, outbox } = makeDeliverer({ bindings: [{ wxUser: { openid: 'openid-1' } }], sendSubscribeMessage: send });
    const lease = new Date('2030-01-01T00:00:30.000Z');
    outbox.claimBatch.mockResolvedValue([
      { id: 'ok-1', tenantId: 'tenant-1', aggregateType: 'Bill', eventType: 'bill.published', payload: { houseId: 'house-1' }, claimOwner: 'w-1', claimExpiresAt: lease },
      { id: 'retry-1', tenantId: 'tenant-1', aggregateType: 'Bill', eventType: 'bill.published', payload: { houseId: 'house-1' }, claimOwner: 'w-1', claimExpiresAt: lease },
    ]);

    const stats = await service.dispatchOutboxBatch({ tenantId: 'tenant-1', workerId: 'w-1' });

    expect(stats).toEqual({ delivered: 1, skipped: 0, retried: 1 });
    expect(outbox.markPublished).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'ok-1', workerId: 'w-1', claimExpiresAt: lease }),
    );
    expect(outbox.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'retry-1', workerId: 'w-1', claimExpiresAt: lease }),
    );
  });

  it('定时投递默认关闭', async () => {
    const { service, outbox } = makeDeliverer();
    delete process.env.OUTBOX_DISPATCH_ENABLED;
    await service.scheduledOutboxDispatch();
    expect(outbox.claimBatch).not.toHaveBeenCalled();
  });
});
