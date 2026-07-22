import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';
import { IdempotencyService, hashCanonicalJson } from './idempotency.service';

type StoredRecord = {
  id: string;
  tenantId: string;
  communityId?: string | null;
  actorKey: string;
  action: string;
  requestId: string;
  requestHash: string;
  status: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  responseCode?: number | null;
  responseBody?: unknown;
  errorCode?: string | null;
  errorMessage?: string | null;
  attempts: number;
};

class MemoryIdempotencyDb {
  readonly records = new Map<string, StoredRecord>();

  private key(input: {
    tenantId: string;
    actorKey: string;
    action: string;
    requestId: string;
  }): string {
    return [input.tenantId, input.actorKey, input.action, input.requestId].join('|');
  }

  readonly idempotencyRecord = {
    findUnique: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const composite = where.tenantId_actorKey_action_requestId as Parameters<
        MemoryIdempotencyDb['key']
      >[0];
      if (composite) return this.records.get(this.key(composite)) ?? null;
      const id = where.id as string | undefined;
      return [...this.records.values()].find((record) => record.id === id) ?? null;
    }),
    create: jest.fn(async ({ data }: { data: StoredRecord }) => {
      const key = this.key(data);
      if (this.records.has(key)) {
        throw new Prisma.PrismaClientKnownRequestError('duplicate idempotency key', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      const record = structuredClone(data);
      this.records.set(key, record);
      return structuredClone(record);
    }),
    updateMany: jest.fn(
      async ({ where, data }: { where: Partial<StoredRecord>; data: Partial<StoredRecord> }) => {
        const record = [...this.records.values()].find(
          (candidate) =>
            candidate.id === where.id &&
            candidate.tenantId === where.tenantId &&
            (!where.status || candidate.status === where.status),
        );
        if (!record) return { count: 0 };
        Object.assign(record, structuredClone(data));
        return { count: 1 };
      },
    ),
  };

  readonly $queryRaw = jest.fn(async (query: Prisma.Sql) => {
    const [tenantId, actorKey, action, requestId] = query.values as [
      string,
      string,
      string,
      string,
    ];
    const record = this.records.get(this.key({ tenantId, actorKey, action, requestId }));
    return record ? [structuredClone(record)] : [];
  });
}

const baseRequest = {
  tenantId: 'tenant-1',
  communityId: 'community-1',
  actorKey: 'admin:admin-1',
  action: 'PAY_BILL',
  requestId: 'request-1',
  payload: { billId: 'bill-1', amount: 100 },
};

function createHarness(db = new MemoryIdempotencyDb()) {
  const prisma = {
    t: { idempotencyRecord: db.idempotencyRecord },
    raw: db,
  } as unknown as PrismaService;
  return { service: new IdempotencyService(prisma), db, prisma };
}

describe('hashCanonicalJson', () => {
  it('uses SHA-256 over the canonical JSON bytes', () => {
    expect(hashCanonicalJson({ b: 2, a: 1 })).toBe(
      '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    );
  });

  it('sorts object keys recursively while preserving array order', () => {
    expect(hashCanonicalJson({ z: 1, a: { y: 2, x: [3, 4] } })).toBe(
      hashCanonicalJson({ a: { x: [3, 4], y: 2 }, z: 1 }),
    );
    expect(hashCanonicalJson({ values: [1, 2] })).not.toBe(
      hashCanonicalJson({ values: [2, 1] }),
    );
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, BigInt(1), Array(1)])(
    'rejects non-JSON payload %p',
    (payload) => {
      expect(() => hashCanonicalJson(payload as never)).toThrow('合法 JSON');
    },
  );
});

describe('IdempotencyService', () => {
  it('reserves once and replays the stored sanitized success for the same canonical payload', async () => {
    const { service, db } = createHarness();
    const first = await runWithTenant('tenant-1', () =>
      service.reserve({
        ...baseRequest,
        payload: { amount: 100, nested: { b: 2, a: 1 }, billId: 'bill-1' },
      }),
    );
    expect(first).toMatchObject({ outcome: 'RESERVED' });
    if (first.outcome !== 'RESERVED') throw new Error('expected reservation');

    const completed = await runWithTenant('tenant-1', () =>
      service.complete({
        tenantId: 'tenant-1',
        recordId: first.recordId,
        responseCode: 200,
        responseBody: { ok: true, token: 'response-secret', phone: '13800138000' },
      }),
    );
    const expectedResponse = {
      responseCode: 200,
      responseBody: { ok: true, token: '[REDACTED]', phone: '[REDACTED]' },
    };
    expect(completed).toEqual(expectedResponse);

    const replay = await runWithTenant('tenant-1', () =>
      service.reserve({
        ...baseRequest,
        payload: { billId: 'bill-1', nested: { a: 1, b: 2 }, amount: 100 },
      }),
    );
    expect(replay).toMatchObject({ outcome: 'REPLAY', ...expectedResponse });
    expect(JSON.stringify([...db.records.values()])).not.toContain('response-secret');
    expect(JSON.stringify([...db.records.values()])).not.toContain('13800138000');
  });

  it('rejects reuse of the same key with a different request hash', async () => {
    const { service } = createHarness();
    await runWithTenant('tenant-1', () => service.reserve(baseRequest));

    await expect(
      runWithTenant('tenant-1', () =>
        service.reserve({ ...baseRequest, payload: { billId: 'bill-2', amount: 100 } }),
      ),
    ).rejects.toMatchObject({ code: 40000 });
  });

  it('returns an explicit in-progress result while the first request is processing', async () => {
    const { service } = createHarness();
    await runWithTenant('tenant-1', () => service.reserve(baseRequest));

    await expect(
      runWithTenant('tenant-1', () => service.reserve(baseRequest)),
    ).resolves.toMatchObject({ outcome: 'IN_PROGRESS' });
  });

  it('treats FAILED as terminal and replays only a truncated sanitized failure', async () => {
    const { service, db } = createHarness();
    const first = await runWithTenant('tenant-1', () => service.reserve(baseRequest));
    if (first.outcome !== 'RESERVED') throw new Error('expected reservation');
    const sensitiveError = `Bearer failure-token phone 13800138000 ${'x'.repeat(400)}`;

    await runWithTenant('tenant-1', () =>
      service.fail({
        tenantId: 'tenant-1',
        recordId: first.recordId,
        errorCode: 'PROVIDER_FAILED',
        errorMessage: sensitiveError,
      }),
    );

    const replay = await runWithTenant('tenant-1', () => service.reserve(baseRequest));
    expect(replay).toMatchObject({ outcome: 'FAILED', errorCode: 'PROVIDER_FAILED' });
    if (replay.outcome !== 'FAILED') throw new Error('expected failed replay');
    expect(replay.errorMessage.length).toBeLessThanOrEqual(191);
    expect(replay.errorMessage).not.toContain('failure-token');
    expect(replay.errorMessage).not.toContain('13800138000');
    expect(db.records.size).toBe(1);
  });

  it('scopes otherwise identical request IDs independently by actor and action', async () => {
    const { service, db } = createHarness();

    const results = await runWithTenant('tenant-1', () =>
      Promise.all([
        service.reserve(baseRequest),
        service.reserve({ ...baseRequest, actorKey: 'admin:admin-2' }),
        service.reserve({ ...baseRequest, action: 'REFUND_PAYMENT' }),
      ]),
    );

    expect(results.map((result: { outcome: string }) => result.outcome)).toEqual([
      'RESERVED',
      'RESERVED',
      'RESERVED',
    ]);
    expect(db.records.size).toBe(3);
  });

  it('resolves a concurrent unique-key race with one reservation and one in-progress result', async () => {
    const { service, db } = createHarness();

    const results = await runWithTenant('tenant-1', () =>
      Promise.all([service.reserve(baseRequest), service.reserve(baseRequest)]),
    );

    expect(results.map((result: { outcome: string }) => result.outcome).sort()).toEqual([
      'IN_PROGRESS',
      'RESERVED',
    ]);
    expect(db.records.size).toBe(1);
  });

  it('uses a non-mutating current read after P2002 in a caller transaction', async () => {
    const { service } = createHarness();
    const stored = {
      id: 'existing-record',
      tenantId: 'tenant-1',
      communityId: 'community-1',
      actorKey: baseRequest.actorKey,
      action: baseRequest.action,
      requestId: baseRequest.requestId,
      status: 'PROCESSING',
      requestHash: hashCanonicalJson(baseRequest.payload),
      responseCode: null,
      responseBody: null,
      errorCode: null,
      errorMessage: null,
      attempts: 1,
      claimOwner: null,
      claimExpiresAt: null,
      nextRetryAt: null,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const current = {
      ...stored,
      status: 'SUCCEEDED',
      responseCode: 200,
      responseBody: { ok: true },
      updatedAt: new Date(stored.updatedAt.getTime() + 1),
    };
    const transaction = {
      idempotencyRecord: {
        findUnique: jest.fn(async () => stored),
        create: jest.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError('duplicate idempotency key', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }),
        updateMany: jest.fn(async () => {
          throw new Error('P2002 recovery must not mutate the existing record');
        }),
      },
      $queryRaw: jest.fn(async () => [current]),
    };

    await expect(
      runWithTenant('tenant-1', () => service.reserve(baseRequest, transaction as never)),
    ).resolves.toMatchObject({
      outcome: 'REPLAY',
      recordId: 'existing-record',
      responseCode: 200,
      responseBody: { ok: true },
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transaction.idempotencyRecord.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a caller transaction when no tenant context is active', async () => {
    const { service } = createHarness();
    const transactionDb = new MemoryIdempotencyDb();

    await expect(service.reserve(baseRequest, transactionDb as never)).rejects.toMatchObject({
      code: 40300,
    });
    expect(transactionDb.records.size).toBe(0);
  });

  it('supports reserve, complete, and fail against a caller transaction', async () => {
    const defaultHarness = createHarness();
    const transactionDb = new MemoryIdempotencyDb();

    const reservation = await runWithTenant('tenant-1', () =>
      defaultHarness.service.reserve(baseRequest, transactionDb as never),
    );
    if (reservation.outcome !== 'RESERVED') throw new Error('expected reservation');
    await runWithTenant('tenant-1', () =>
      defaultHarness.service.complete(
        {
          tenantId: 'tenant-1',
          recordId: reservation.recordId,
          responseCode: 201,
          responseBody: { created: true },
        },
        transactionDb as never,
      ),
    );

    const failedReservation = await runWithTenant('tenant-1', () =>
      defaultHarness.service.reserve(
        { ...baseRequest, requestId: 'request-failed' },
        transactionDb as never,
      ),
    );
    if (failedReservation.outcome !== 'RESERVED') throw new Error('expected reservation');
    await runWithTenant('tenant-1', () =>
      defaultHarness.service.fail(
        {
          tenantId: 'tenant-1',
          recordId: failedReservation.recordId,
          errorCode: 'PROVIDER_FAILED',
          errorMessage: 'provider failed',
        },
        transactionDb as never,
      ),
    );

    expect(defaultHarness.db.records.size).toBe(0);
    expect([...transactionDb.records.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'SUCCEEDED', responseCode: 201 }),
        expect.objectContaining({ status: 'FAILED', errorCode: 'PROVIDER_FAILED' }),
      ]),
    );
  });

  it('allows each PROCESSING record to reach exactly one terminal state', async () => {
    const { service } = createHarness();
    const succeeded = await runWithTenant('tenant-1', () => service.reserve(baseRequest));
    if (succeeded.outcome !== 'RESERVED') throw new Error('expected reservation');
    await runWithTenant('tenant-1', () =>
      service.complete({
        tenantId: 'tenant-1',
        recordId: succeeded.recordId,
        responseCode: 200,
        responseBody: { ok: true },
      }),
    );
    await expect(
      runWithTenant('tenant-1', () =>
        service.fail({
          tenantId: 'tenant-1',
          recordId: succeeded.recordId,
          errorCode: 'LATE_FAILURE',
          errorMessage: 'too late',
        }),
      ),
    ).rejects.toMatchObject({ code: 40000 });
    await expect(
      runWithTenant('tenant-1', () =>
        service.complete({
          tenantId: 'tenant-1',
          recordId: succeeded.recordId,
          responseCode: 200,
          responseBody: { ok: true },
        }),
      ),
    ).rejects.toMatchObject({ code: 40000 });

    const failed = await runWithTenant('tenant-1', () =>
      service.reserve({ ...baseRequest, requestId: 'request-terminal-failure' }),
    );
    if (failed.outcome !== 'RESERVED') throw new Error('expected reservation');
    await runWithTenant('tenant-1', () =>
      service.fail({
        tenantId: 'tenant-1',
        recordId: failed.recordId,
        errorCode: 'FAILED',
        errorMessage: 'terminal',
      }),
    );
    await expect(
      runWithTenant('tenant-1', () =>
        service.complete({
          tenantId: 'tenant-1',
          recordId: failed.recordId,
          responseCode: 200,
          responseBody: { ok: true },
        }),
      ),
    ).rejects.toMatchObject({ code: 40000 });
  });

  it('stores only the request hash and rejects a mismatched active tenant', async () => {
    const { service, db } = createHarness();
    const requestSecret = 'request-api-v3-secret';
    await runWithTenant('tenant-1', () =>
      service.reserve({ ...baseRequest, payload: { apiV3Key: requestSecret } }),
    );
    expect(JSON.stringify([...db.records.values()])).not.toContain(requestSecret);

    await expect(
      runWithTenant('tenant-2', () => service.reserve(baseRequest)),
    ).rejects.toMatchObject({ code: 40300 });
  });
});
