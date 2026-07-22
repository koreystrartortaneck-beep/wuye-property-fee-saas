import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { Prisma } from '@prisma/client';
import { redactAndTruncateText, redactSensitive, assertTenantAccess } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { BizException } from './biz.exception';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BizException(ErrorCode.VALIDATION, '请求体必须是合法 JSON');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new BizException(ErrorCode.VALIDATION, '请求体必须是合法 JSON');
  }
  if (ancestors.has(value)) throw new BizException(ErrorCode.VALIDATION, '请求体必须是合法 JSON');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new BizException(ErrorCode.VALIDATION, '请求体必须是合法 JSON');
        }
        items.push(canonicalJson(value[index], ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (Object.prototype.toString.call(value) !== '[object Object]') {
      throw new BizException(ErrorCode.VALIDATION, '请求体必须是合法 JSON');
    }
    if (
      prototype !== null &&
      (typeof prototype.constructor !== 'function' || prototype.constructor.name !== 'Object')
    ) {
      throw new BizException(ErrorCode.VALIDATION, '请求体必须是合法 JSON');
    }
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`);
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function hashCanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export interface ReserveIdempotencyInput {
  tenantId: string;
  communityId?: string | null;
  actorKey: string;
  action: string;
  requestId: string;
  payload: unknown;
  expiresAt?: Date | null;
}

export type IdempotencyReservation =
  | { outcome: 'RESERVED'; recordId: string; requestHash: string }
  | {
      outcome: 'REPLAY';
      recordId: string;
      responseCode: number | null;
      responseBody: unknown;
    }
  | { outcome: 'IN_PROGRESS'; recordId: string }
  | {
      outcome: 'FAILED';
      recordId: string;
      errorCode: string;
      errorMessage: string;
    };

export interface CompleteIdempotencyInput {
  tenantId: string;
  recordId: string;
  responseCode: number;
  responseBody: unknown;
}

export interface FailIdempotencyInput {
  tenantId: string;
  recordId: string;
  errorCode: string;
  errorMessage: unknown;
}

export interface CompletedIdempotencyResult {
  responseCode: number;
  responseBody: unknown;
}

export type IdempotencyTransaction = Pick<
  Prisma.TransactionClient,
  'idempotencyRecord' | '$queryRaw'
>;

type StoredIdempotencyRecord = Prisma.IdempotencyRecordGetPayload<Record<string, never>>;
type IdempotencyUniqueKey = Pick<
  StoredIdempotencyRecord,
  'tenantId' | 'actorKey' | 'action' | 'requestId'
>;

function jsonForStorage(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  const redacted = redactSensitive(value);
  return redacted === null ? Prisma.JsonNull : (redacted as Prisma.InputJsonValue);
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  private client(transaction?: IdempotencyTransaction): IdempotencyTransaction {
    return transaction ?? (this.prisma.t as unknown as IdempotencyTransaction);
  }

  private async currentRecord(
    unique: IdempotencyUniqueKey,
    transaction?: IdempotencyTransaction,
  ): Promise<StoredIdempotencyRecord | null> {
    const queryClient = transaction ?? this.prisma.raw;
    const [record] = await queryClient.$queryRaw<StoredIdempotencyRecord[]>(Prisma.sql`
      SELECT *
      FROM \`IdempotencyRecord\`
      WHERE \`tenantId\` = ${unique.tenantId}
        AND \`actorKey\` = ${unique.actorKey}
        AND \`action\` = ${unique.action}
        AND \`requestId\` = ${unique.requestId}
      FOR SHARE
    `);
    return record ?? null;
  }

  private resolveExisting(
    record: StoredIdempotencyRecord,
    requestHash: string,
  ): IdempotencyReservation {
    if (record.requestHash !== requestHash) {
      throw new BizException(ErrorCode.VALIDATION, '幂等键已用于不同请求');
    }
    if (record.status === 'SUCCEEDED') {
      return {
        outcome: 'REPLAY',
        recordId: record.id,
        responseCode: record.responseCode,
        responseBody: redactSensitive(record.responseBody),
      };
    }
    if (record.status === 'FAILED') {
      return {
        outcome: 'FAILED',
        recordId: record.id,
        errorCode: record.errorCode ?? 'FAILED',
        errorMessage: redactAndTruncateText(record.errorMessage ?? '请求已失败'),
      };
    }
    return { outcome: 'IN_PROGRESS', recordId: record.id };
  }

  async reserve(
    input: ReserveIdempotencyInput,
    transaction?: IdempotencyTransaction,
  ): Promise<IdempotencyReservation> {
    assertTenantAccess(input.tenantId);
    const requestHash = hashCanonicalJson(input.payload);
    const client = this.client(transaction);
    const unique = {
      tenantId: input.tenantId,
      actorKey: input.actorKey,
      action: input.action,
      requestId: input.requestId,
    };
    const where = { tenantId_actorKey_action_requestId: unique };
    if (!transaction) {
      const existing = await client.idempotencyRecord.findUnique({ where });
      if (existing) return this.resolveExisting(existing, requestHash);
    }

    const recordId = randomUUID();
    try {
      await client.idempotencyRecord.create({
        data: {
          id: recordId,
          tenantId: input.tenantId,
          communityId: input.communityId ?? null,
          actorKey: input.actorKey,
          action: input.action,
          requestId: input.requestId,
          status: 'PROCESSING',
          requestHash,
          attempts: 1,
          expiresAt: input.expiresAt ?? null,
        },
      });
      return { outcome: 'RESERVED', recordId, requestHash };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      // Locking reads are current reads under MySQL REPEATABLE READ. A shared lock
      // avoids mutating terminal records and lets concurrent duplicate callers coexist.
      const raced = await this.currentRecord(unique, transaction);
      if (!raced) throw error;
      return this.resolveExisting(raced, requestHash);
    }
  }

  /** Returns the exact sanitized body that callers must use for the first response. */
  async complete(
    input: CompleteIdempotencyInput,
    transaction?: IdempotencyTransaction,
  ): Promise<CompletedIdempotencyResult> {
    assertTenantAccess(input.tenantId);
    const responseBody = redactSensitive(input.responseBody);
    const result = await this.client(transaction).idempotencyRecord.updateMany({
      where: {
        id: input.recordId,
        tenantId: input.tenantId,
        status: 'PROCESSING',
      },
      data: {
        status: 'SUCCEEDED',
        responseCode: input.responseCode,
        responseBody: jsonForStorage(responseBody),
        errorCode: null,
        errorMessage: null,
      },
    });
    if (result.count !== 1) {
      throw new BizException(ErrorCode.VALIDATION, '幂等记录不处于处理中状态');
    }
    return { responseCode: input.responseCode, responseBody };
  }

  /** FAILED is terminal: future matching reserves replay this stored failure. */
  async fail(input: FailIdempotencyInput, transaction?: IdempotencyTransaction): Promise<void> {
    assertTenantAccess(input.tenantId);
    const result = await this.client(transaction).idempotencyRecord.updateMany({
      where: {
        id: input.recordId,
        tenantId: input.tenantId,
        status: 'PROCESSING',
      },
      data: {
        status: 'FAILED',
        errorCode: redactAndTruncateText(input.errorCode),
        errorMessage: redactAndTruncateText(input.errorMessage),
        responseCode: null,
        responseBody: Prisma.DbNull,
      },
    });
    if (result.count !== 1) {
      throw new BizException(ErrorCode.VALIDATION, '幂等记录不处于处理中状态');
    }
  }
}
