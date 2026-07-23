import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { AuditService, redactAndTruncateText } from '../audit/audit.service';
import { BizException } from '../common/biz.exception';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';

export type IncidentSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type IncidentStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface OpenIncidentInput {
  tenantId: string;
  communityId?: string | null;
  dedupKey: string;
  title: string;
  severity: IncidentSeverity;
}

export interface TransitionInput {
  tenantId: string;
  id: string;
  adminId: string;
  reason?: string | null;
}

export interface ListIncidentsQuery extends PageQuery {
  tenantId: string;
  status?: IncidentStatus;
}

/**
 * 运营事件（Incident）：严重告警映射到去重的事件，OPEN → ACKNOWLEDGED → RESOLVED，
 * 记录处置人/原因/时间并写审计；解决后再次复发重新打开。状态转换幂等。
 */
@Injectable()
export class IncidentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private writeAudit(tenantId: string, input: Parameters<AuditService['append']>[0]) {
    // 告警链路可能无租户上下文（webhook/定时任务），以显式租户建立上下文再写审计。
    return runWithTenant(tenantId, () => this.audit.append(input, undefined)).catch(() => undefined);
  }

  async openOrReopen(input: OpenIncidentInput) {
    const existing = await this.prisma.raw.incident.findUnique({
      where: { tenantId_dedupKey: { tenantId: input.tenantId, dedupKey: input.dedupKey } },
    });
    if (!existing) {
      const created = await this.prisma.raw.incident.create({
        data: {
          tenantId: input.tenantId,
          communityId: input.communityId ?? null,
          dedupKey: input.dedupKey,
          title: input.title,
          severity: input.severity,
          status: 'OPEN',
          occurrences: 1,
        },
      });
      await this.writeAudit(input.tenantId, {
        tenantId: input.tenantId,
        communityId: input.communityId ?? null,
        actorType: 'SYSTEM',
        action: 'CREATE',
        resourceType: 'Incident',
        resourceId: created.id,
        reason: input.title,
        afterSummary: { status: 'OPEN', dedupKey: input.dedupKey },
      });
      return created;
    }
    if (existing.status === 'RESOLVED') {
      const reopened = await this.prisma.raw.incident.update({
        where: { tenantId_id: { tenantId: input.tenantId, id: existing.id } },
        data: {
          status: 'OPEN',
          resolvedAt: null,
          resolvedBy: null,
          acknowledgedAt: null,
          acknowledgedBy: null,
          occurrences: { increment: 1 },
          lastSeenAt: new Date(),
        },
      });
      await this.writeAudit(input.tenantId, {
        tenantId: input.tenantId,
        communityId: existing.communityId,
        actorType: 'SYSTEM',
        action: 'UPDATE',
        resourceType: 'Incident',
        resourceId: existing.id,
        reason: '事件复发重新打开',
        beforeSummary: { status: 'RESOLVED' },
        afterSummary: { status: 'OPEN' },
      });
      return reopened;
    }
    return this.prisma.raw.incident.update({
      where: { tenantId_id: { tenantId: input.tenantId, id: existing.id } },
      data: { occurrences: { increment: 1 }, lastSeenAt: new Date() },
    });
  }

  private async load(tenantId: string, id: string) {
    const inc = await this.prisma.raw.incident.findUnique({ where: { tenantId_id: { tenantId, id } } });
    if (!inc) throw new BizException(ErrorCode.NOT_FOUND, '事件不存在');
    return inc;
  }

  async acknowledge(input: TransitionInput) {
    const inc = await this.load(input.tenantId, input.id);
    if (inc.status !== 'OPEN') return inc; // 幂等
    const updated = await this.prisma.raw.incident.update({
      where: { tenantId_id: { tenantId: input.tenantId, id: input.id } },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date(),
        acknowledgedBy: input.adminId,
        reason: input.reason ? redactAndTruncateText(input.reason) : inc.reason,
      },
    });
    await this.writeAudit(input.tenantId, {
      tenantId: input.tenantId,
      communityId: inc.communityId,
      actorType: 'ADMIN',
      actorId: input.adminId,
      action: 'UPDATE',
      resourceType: 'Incident',
      resourceId: input.id,
      reason: input.reason ?? null,
      beforeSummary: { status: inc.status },
      afterSummary: { status: 'ACKNOWLEDGED' },
    });
    return updated;
  }

  async resolve(input: TransitionInput) {
    const inc = await this.load(input.tenantId, input.id);
    if (inc.status === 'RESOLVED') return inc; // 幂等
    const updated = await this.prisma.raw.incident.update({
      where: { tenantId_id: { tenantId: input.tenantId, id: input.id } },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        resolvedBy: input.adminId,
        reason: input.reason ? redactAndTruncateText(input.reason) : inc.reason,
      },
    });
    await this.writeAudit(input.tenantId, {
      tenantId: input.tenantId,
      communityId: inc.communityId,
      actorType: 'ADMIN',
      actorId: input.adminId,
      action: 'UPDATE',
      resourceType: 'Incident',
      resourceId: input.id,
      reason: input.reason ?? null,
      beforeSummary: { status: inc.status },
      afterSummary: { status: 'RESOLVED' },
    });
    return updated;
  }

  async list(query: ListIncidentsQuery) {
    const where = {
      tenantId: query.tenantId,
      ...(query.status ? { status: query.status } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.t.incident.findMany({ where, ...pageArgs(query), orderBy: [{ openedAt: 'desc' }, { id: 'desc' }] }),
      this.prisma.t.incident.count({ where }),
    ]);
    return pageResult(list, total, query);
  }

  get(tenantId: string, id: string) {
    return this.load(tenantId, id);
  }
}
