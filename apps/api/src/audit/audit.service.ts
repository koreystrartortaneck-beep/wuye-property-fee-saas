import { Injectable } from '@nestjs/common';
import { AuditAction, AuditActorType, ErrorCode } from '@pf/shared';
import { Prisma } from '@prisma/client';
import { BizException } from '../common/biz.exception';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantContext } from '../tenant/tenant-cls';

export const REDACTED_VALUE = '[REDACTED]';

const SENSITIVE_WORDS = new Set([
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'key',
  'mobile',
  'openid',
  'password',
  'phone',
  'secret',
  'session',
  'token',
]);

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSensitiveKey(key: string): boolean {
  const words = keyWords(key);
  const compact = words.join('');
  return (
    words.some((word) => SENSITIVE_WORDS.has(word)) ||
    /(?:secret|token|password|passwd|pwd|credentials?|sessionid|openid|phone|mobile)$/.test(
      compact,
    ) ||
    /(?:api|private|signing|encryption)key$/.test(compact) ||
    compact.includes('rawcallback') ||
    compact.includes('callbackraw') ||
    compact.includes('apiv3')
  );
}

function redactString(value: string): string {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)) return REDACTED_VALUE;

  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') {
        return JSON.stringify(redactSensitive(parsed));
      }
    } catch {
      // Non-JSON diagnostic text is handled by the patterns below.
    }
  }

  return value
    .replace(
      /\b(authorization|set[-_]?cookie|cookie)(\s*[:=]\s*)[^\r\n]*/gi,
      (_match, label: string, separator: string) =>
        `${label}${separator}${REDACTED_VALUE}`,
    )
    .replace(
      /(["']?)(\b(?:authorization|set[-_]?cookie|cookie|session(?:[_-]?id)?|credentials?|app[_-]?secret|client[_-]?secret|password|passwd|pwd|(?:access|refresh)?[_-]?token|secret|private[_-]?key|api[_-]?key|api[_-]?v?3(?:[_-]?key)?|raw[_-]?callback|openid|phone|mobile|key)\b)\1(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|(?:Bearer|Basic)\s+[^\s,;]+|[^\s,;]+)/gi,
      (
        _match,
        keyQuote: string,
        label: string,
        separator: string,
        sensitiveValue: string,
      ) => {
        const valueQuote = sensitiveValue[0];
        const replacement =
          valueQuote === '"' || valueQuote === "'"
            ? `${valueQuote}${REDACTED_VALUE}${valueQuote}`
            : REDACTED_VALUE;
        return `${keyQuote}${label}${keyQuote}${separator}${replacement}`;
      },
    )
    .replace(/(?:Bearer|Basic)\s+[^\s,;]+/gi, (match) => {
      const scheme = match.slice(0, match.indexOf(' '));
      return `${scheme} ${REDACTED_VALUE}`;
    })
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED_VALUE)
    // 仅脱敏「独立」的 11 位手机号（前后非字母数字），避免误伤 nonceStr/prepay_id/base64 等
    // 不透明串里恰好出现的 11 位数字段（否则会污染微信支付 payParams 导致重放签名失败）。
    .replace(/(^|[^0-9A-Za-z])1[3-9]\d{9}(?![0-9A-Za-z])/g, (_match, prefix: string) => `${prefix}${REDACTED_VALUE}`);
}

function invalidJsonSummary(): never {
  throw new BizException(ErrorCode.VALIDATION, '摘要必须是合法 JSON');
}

function redactJsonValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (
    value === null ||
    value === Prisma.JsonNull ||
    value === Prisma.DbNull ||
    value === Prisma.AnyNull
  ) {
    return null;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidJsonSummary();
    return value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) invalidJsonSummary();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) invalidJsonSummary();
        result.push(redactJsonValue(value[index], ancestors));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    const isPlainObject =
      prototype === null ||
      (Object.prototype.toString.call(value) === '[object Object]' &&
        typeof prototype.constructor === 'function' &&
        prototype.constructor.name === 'Object');
    if (!isPlainObject) {
      const toJSON = (value as { toJSON?: unknown }).toJSON;
      if (typeof toJSON !== 'function') invalidJsonSummary();
      const normalized = toJSON.call(value) as unknown;
      if (normalized === value) invalidJsonSummary();
      return redactJsonValue(normalized, ancestors);
    }

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) invalidJsonSummary();
      result[key] = isSensitiveKey(key)
        ? REDACTED_VALUE
        : redactJsonValue(child, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Recursively returns a JSON-safe summary with common credential and identity fields removed. */
export function redactSensitive(value: unknown): unknown {
  return redactJsonValue(value, new WeakSet<object>());
}

function jsonSummaryForStorage(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  const redacted = redactSensitive(value);
  return redacted === null ? Prisma.JsonNull : (redacted as Prisma.InputJsonValue);
}

/** Redacts credentials and phone numbers before fitting text into a VARCHAR column. */
export function redactAndTruncateText(value: unknown, maxLength = 191): string {
  const message = value instanceof Error ? value.message : String(value);
  return redactString(message).slice(0, maxLength);
}

export function assertTenantAccess(tenantId: string, allowMissingContext = false): void {
  const context = getTenantContext();
  if (!context.set) {
    if (allowMissingContext) return;
    throw new BizException(ErrorCode.FORBIDDEN, '缺少租户上下文');
  }
  if (context.tenantId !== null && context.tenantId !== tenantId) {
    throw new BizException(ErrorCode.FORBIDDEN, '租户上下文不匹配');
  }
}

export interface AppendAuditInput {
  tenantId: string;
  communityId?: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  action: AuditAction;
  resourceType: string;
  resourceId: string;
  reason?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  beforeSummary?: unknown;
  afterSummary?: unknown;
}

export interface AuditListQuery extends PageQuery {
  action?: AuditAction;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  communityId?: string;
  from?: string;
  to?: string;
}

export type AuditTransaction = Pick<Prisma.TransactionClient, 'auditLog'>;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async append(input: AppendAuditInput, transaction?: AuditTransaction) {
    assertTenantAccess(input.tenantId);
    const client = transaction ?? (this.prisma.t as unknown as AuditTransaction);
    const data = {
      tenantId: input.tenantId,
      communityId: input.communityId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      reason:
        input.reason === undefined || input.reason === null
          ? null
          : redactAndTruncateText(input.reason),
      requestId: input.requestId ?? null,
      ip: input.ip ?? null,
      userAgent:
        input.userAgent === undefined || input.userAgent === null
          ? null
          : redactAndTruncateText(input.userAgent),
      beforeSummary:
        input.beforeSummary === undefined
          ? undefined
          : jsonSummaryForStorage(input.beforeSummary),
      afterSummary:
        input.afterSummary === undefined
          ? undefined
          : jsonSummaryForStorage(input.afterSummary),
    } satisfies Prisma.AuditLogUncheckedCreateInput;
    return client.auditLog.create({ data });
  }

  async list(query: AuditListQuery) {
    const createdAt =
      query.from || query.to
        ? {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          }
        : undefined;
    const where = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.communityId ? { communityId: query.communityId } : {}),
      ...(createdAt ? { createdAt } : {}),
    } satisfies Prisma.AuditLogWhereInput;
    const [rows, total] = await Promise.all([
      this.prisma.t.auditLog.findMany({
        where,
        ...pageArgs(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.t.auditLog.count({ where }),
    ]);
    const list = rows.map((row) => ({
      ...row,
      reason:
        row.reason === null ? null : redactAndTruncateText(row.reason),
      userAgent:
        row.userAgent === null ? null : redactAndTruncateText(row.userAgent),
      beforeSummary: redactSensitive(row.beforeSummary),
      afterSummary: redactSensitive(row.afterSummary),
    }));
    return pageResult(list, total, query);
  }
}
