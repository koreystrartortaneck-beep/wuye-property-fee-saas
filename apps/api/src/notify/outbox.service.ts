import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { Prisma } from '@prisma/client';
import {
  assertTenantAccess,
  redactAndTruncateText,
  redactSensitive,
} from '../audit/audit.service';
import { BizException } from '../common/biz.exception';
import { hashCanonicalJson } from '../common/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';

export interface EnqueueOutboxInput {
  tenantId: string;
  communityId?: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  dedupKey: string;
  payload: unknown;
  availableAt?: Date;
}

export interface ClaimOutboxBatchInput {
  tenantId: string;
  workerId: string;
  limit?: number;
  leaseMs?: number;
}

export interface MarkOutboxPublishedInput {
  tenantId: string;
  eventId: string;
  workerId: string;
  claimExpiresAt: Date;
}

export interface MarkOutboxFailedInput extends MarkOutboxPublishedInput {
  error: unknown;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export type OutboxTransaction = Pick<
  Prisma.TransactionClient,
  'outboxEvent' | '$queryRaw'
>;

type OutboxWorkerTransaction = Pick<Prisma.TransactionClient, 'outboxEvent' | '$queryRaw'>;
type StoredOutboxEvent = Prisma.OutboxEventGetPayload<Record<string, never>>;

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 30_000;
const DEFAULT_MAX_BACKOFF_MS = 60 * 60 * 1000;
const TERMINAL_AVAILABLE_AT = new Date('9999-12-31T23:59:59.999Z');

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BizException(ErrorCode.VALIDATION, `${label} 必须是正整数`);
  }
  return value;
}

function payloadForStorage(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

function assertSameEvent(
  existing: StoredOutboxEvent,
  input: EnqueueOutboxInput,
  sanitizedPayload: unknown,
): void {
  const sameIdentity =
    existing.communityId === (input.communityId ?? null) &&
    existing.aggregateType === input.aggregateType &&
    existing.aggregateId === input.aggregateId &&
    existing.eventType === input.eventType;
  const samePayload = hashCanonicalJson(existing.payload) === hashCanonicalJson(sanitizedPayload);
  if (!sameIdentity || !samePayload) {
    throw new BizException(ErrorCode.VALIDATION, 'Outbox dedupKey 已用于不同事件');
  }
}

type DatabaseQueryClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

async function currentDatabaseTime(client: DatabaseQueryClient): Promise<Date> {
  const [row] = await client.$queryRaw<Array<{ dbNow: Date }>>(
    Prisma.sql`SELECT UTC_TIMESTAMP(3) AS \`dbNow\``,
  );
  if (!row) throw new BizException(ErrorCode.INTERNAL, '无法读取数据库时间');
  return row.dbNow;
}

async function lockOwnedLease(
  client: OutboxWorkerTransaction,
  input: MarkOutboxPublishedInput,
): Promise<{ attempts: number; dbNow: Date } | null> {
  const [lease] = await client.$queryRaw<Array<{ attempts: number; dbNow: Date }>>(Prisma.sql`
    SELECT \`attempts\`, UTC_TIMESTAMP(3) AS \`dbNow\`
    FROM \`OutboxEvent\`
    WHERE \`id\` = ${input.eventId}
      AND \`tenantId\` = ${input.tenantId}
      AND \`status\` = 'PROCESSING'
      AND BINARY \`claimOwner\` = BINARY ${input.workerId}
      AND \`claimExpiresAt\` = ${input.claimExpiresAt}
      AND \`claimExpiresAt\` > UTC_TIMESTAMP(3)
    FOR UPDATE
  `);
  return lease ?? null;
}

@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  private enqueueClient(transaction?: OutboxTransaction): OutboxTransaction {
    return transaction ?? (this.prisma.t as unknown as OutboxTransaction);
  }

  private async currentEvent(
    tenantId: string,
    dedupKey: string,
    transaction?: OutboxTransaction,
  ): Promise<StoredOutboxEvent | null> {
    const queryClient = transaction ?? this.prisma.raw;
    const [event] = await queryClient.$queryRaw<StoredOutboxEvent[]>(Prisma.sql`
      SELECT *
      FROM \`OutboxEvent\`
      WHERE \`tenantId\` = ${tenantId}
        AND \`dedupKey\` = ${dedupKey}
      FOR SHARE
    `);
    return event ?? null;
  }

  async enqueue(input: EnqueueOutboxInput, transaction?: OutboxTransaction) {
    assertTenantAccess(input.tenantId);
    const client = this.enqueueClient(transaction);
    const sanitizedPayload = redactSensitive(input.payload);
    const where = {
      tenantId_dedupKey: {
        tenantId: input.tenantId,
        dedupKey: input.dedupKey,
      },
    };
    if (!transaction) {
      const existing = await client.outboxEvent.findUnique({ where });
      if (existing) {
        assertSameEvent(existing, input, sanitizedPayload);
        return existing;
      }
    }

    const availableAt =
      input.availableAt ?? (await currentDatabaseTime(transaction ?? this.prisma.raw));
    try {
      return await client.outboxEvent.create({
        data: {
          tenantId: input.tenantId,
          communityId: input.communityId ?? null,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          eventType: input.eventType,
          dedupKey: input.dedupKey,
          payload: payloadForStorage(sanitizedPayload),
          status: 'PENDING',
          attempts: 0,
          availableAt,
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      // Locking reads are current reads under MySQL REPEATABLE READ. A shared lock
      // avoids lock-upgrade deadlocks between concurrent duplicate transactions.
      const raced = await this.currentEvent(input.tenantId, input.dedupKey, transaction);
      if (!raced) throw error;
      assertSameEvent(raced, input, sanitizedPayload);
      return raced;
    }
  }

  async claimBatch(input: ClaimOutboxBatchInput): Promise<StoredOutboxEvent[]> {
    assertTenantAccess(input.tenantId, true);
    const limit = positiveInteger(input.limit ?? DEFAULT_BATCH_SIZE, 'limit');
    const leaseMs = positiveInteger(input.leaseMs ?? DEFAULT_LEASE_MS, 'leaseMs');
    const terminalNow = await currentDatabaseTime(this.prisma.raw);

    await this.prisma.raw.outboxEvent.updateMany({
      where: {
        tenantId: input.tenantId,
        status: 'PROCESSING',
        attempts: { gte: DEFAULT_MAX_ATTEMPTS },
        claimExpiresAt: { lte: terminalNow },
      },
      data: {
        status: 'FAILED',
        availableAt: TERMINAL_AVAILABLE_AT,
        claimOwner: null,
        claimExpiresAt: null,
        lastError: 'Outbox lease expired after maximum attempts',
      },
    });

    return this.prisma.raw.$transaction(async (transaction) => {
      const client = transaction as unknown as OutboxWorkerTransaction;
      const candidates = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT \`id\`
        FROM \`OutboxEvent\`
        WHERE \`tenantId\` = ${input.tenantId}
          AND \`attempts\` < ${DEFAULT_MAX_ATTEMPTS}
          AND (
            (\`status\` IN ('PENDING', 'FAILED') AND \`availableAt\` <= UTC_TIMESTAMP(3))
            OR
            (\`status\` = 'PROCESSING' AND \`claimExpiresAt\` <= UTC_TIMESTAMP(3))
          )
        ORDER BY \`availableAt\`, \`createdAt\`, \`id\`
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      const ids = candidates.map(({ id }) => id);
      if (ids.length === 0) return [];

      const claimStartedAt = await currentDatabaseTime(client);
      const claimExpiresAt = new Date(claimStartedAt.getTime() + leaseMs);
      const claimed = await client.outboxEvent.updateMany({
        where: { id: { in: ids }, tenantId: input.tenantId },
        data: {
          status: 'PROCESSING',
          claimOwner: input.workerId,
          claimExpiresAt,
          attempts: { increment: 1 },
          lastAttemptAt: claimStartedAt,
        },
      });
      if (claimed.count !== ids.length) {
        throw new BizException(ErrorCode.INTERNAL, 'Outbox 候选事件在领取事务内发生变化');
      }
      return client.outboxEvent.findMany({
        where: {
          id: { in: ids },
          tenantId: input.tenantId,
          status: 'PROCESSING',
          claimOwner: input.workerId,
          claimExpiresAt,
        },
        orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
    }, {
      maxWait: 5_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }

  async markPublished(input: MarkOutboxPublishedInput): Promise<void> {
    assertTenantAccess(input.tenantId, true);
    await this.prisma.raw.$transaction(async (transaction) => {
      const client = transaction as unknown as OutboxWorkerTransaction;
      const lease = await lockOwnedLease(client, input);
      if (!lease) {
        throw new BizException(ErrorCode.VALIDATION, 'Outbox lease 无效或已过期');
      }
      const result = await client.outboxEvent.updateMany({
        where: {
          id: input.eventId,
          tenantId: input.tenantId,
          status: 'PROCESSING',
          claimOwner: input.workerId,
          claimExpiresAt: input.claimExpiresAt,
        },
        data: {
          status: 'PUBLISHED',
          publishedAt: lease.dbNow,
          claimOwner: null,
          claimExpiresAt: null,
          lastError: null,
        },
      });
      if (result.count !== 1) {
        throw new BizException(ErrorCode.VALIDATION, 'Outbox lease 已被其他 worker 修改');
      }
    }, { maxWait: 5_000, timeout: 30_000 });
  }

  async markFailed(input: MarkOutboxFailedInput): Promise<void> {
    assertTenantAccess(input.tenantId, true);
    const baseBackoffMs = positiveInteger(
      input.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
      'baseBackoffMs',
    );
    const maxBackoffMs = positiveInteger(
      input.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      'maxBackoffMs',
    );

    await this.prisma.raw.$transaction(async (transaction) => {
      const client = transaction as unknown as OutboxWorkerTransaction;
      const lease = await lockOwnedLease(client, input);
      if (!lease) {
        throw new BizException(ErrorCode.VALIDATION, 'Outbox lease 无效或已过期');
      }

      const exponent = Math.max(0, Math.min(lease.attempts - 1, 30));
      const terminal = lease.attempts >= DEFAULT_MAX_ATTEMPTS;
      const delay = Math.min(maxBackoffMs, baseBackoffMs * 2 ** exponent);
      const result = await client.outboxEvent.updateMany({
        where: {
          id: input.eventId,
          tenantId: input.tenantId,
          status: 'PROCESSING',
          attempts: lease.attempts,
          claimOwner: input.workerId,
          claimExpiresAt: input.claimExpiresAt,
        },
        data: {
          status: 'FAILED',
          availableAt: terminal
            ? TERMINAL_AVAILABLE_AT
            : new Date(lease.dbNow.getTime() + delay),
          claimOwner: null,
          claimExpiresAt: null,
          lastError: redactAndTruncateText(input.error),
        },
      });
      if (result.count !== 1) {
        throw new BizException(ErrorCode.VALIDATION, 'Outbox lease 已被其他 worker 修改');
      }
    }, { maxWait: 5_000, timeout: 30_000 });
  }
}
