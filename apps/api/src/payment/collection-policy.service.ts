import { Injectable } from '@nestjs/common';
import { CollectionPolicyStatus, ErrorCode } from '@pf/shared';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';

/** 平台层唯一策略代码（单例全局开关） */
export const PLATFORM_POLICY_CODE = 'GLOBAL';

export type CollectionLayer = 'PLATFORM' | 'TENANT' | 'COMMUNITY';

export interface EffectiveCollectionStatus {
  status: CollectionPolicyStatus;
  pausedLayer: CollectionLayer | null;
  reason: string | null;
}

export interface SetTenantPolicyInput {
  tenantId: string;
  adminId: string;
  status: CollectionPolicyStatus;
  reason: string;
  resumeAt?: Date | null;
  requestId?: string | null;
}

export interface SetCommunityPolicyInput extends SetTenantPolicyInput {
  communityId: string;
}

export interface SetPlatformPolicyInput {
  adminId: string;
  status: CollectionPolicyStatus;
  reason: string;
  resumeAt?: Date | null;
}

type PolicyRow = { status: string; reason?: string | null } | undefined;

/**
 * 分层暂停收款策略：平台 > 租户 > 小区，任一层暂停即暂停。
 * - 收款前（业主流程）用 raw client 读取有效状态；
 * - 支付预占事务内用 FOR SHARE 加锁复核，避免并发暂停被绕过；
 * - 暂停只拦截"新发起支付"，回调入账 / 退款 / 对账不受影响。
 */
@Injectable()
export class CollectionPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private assertReason(reason: string): void {
    if (!reason || !reason.trim()) {
      throw new BizException(ErrorCode.VALIDATION, '变更收款策略必须填写原因');
    }
  }

  /** 读取有效收款状态（不加锁，供收款前预检与前端展示） */
  async resolveEffectiveStatus(
    tenantId: string,
    communityId?: string | null,
  ): Promise<EffectiveCollectionStatus> {
    const [platform, tenant, community] = await Promise.all([
      this.prisma.raw.platformCollectionPolicy.findUnique({ where: { code: PLATFORM_POLICY_CODE } }),
      this.prisma.raw.tenantCollectionPolicy.findUnique({ where: { tenantId } }),
      communityId
        ? this.prisma.raw.communityCollectionPolicy.findUnique({
            where: { tenantId_communityId: { tenantId, communityId } },
          })
        : Promise.resolve(null),
    ]);
    return this.reduce([
      ['PLATFORM', platform],
      ['TENANT', tenant],
      ['COMMUNITY', community],
    ]);
  }

  private reduce(layers: Array<[CollectionLayer, PolicyRow | null]>): EffectiveCollectionStatus {
    for (const [layer, row] of layers) {
      if (row && row.status === 'PAUSED') {
        return { status: 'PAUSED', pausedLayer: layer, reason: row.reason ?? null };
      }
    }
    return { status: 'OPEN', pausedLayer: null, reason: null };
  }

  /**
   * 支付预占事务内加锁复核：对平台 / 租户 / 各小区策略行执行 FOR SHARE，
   * 任一层为 PAUSED 即抛 COLLECTION_PAUSED，回滚整笔预占。
   */
  async assertOpenForUpdate(
    tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
    tenantId: string,
    communityIds: string[],
  ): Promise<void> {
    const [platform] = await tx.$queryRaw<PolicyRow[]>(Prisma.sql`
      SELECT \`status\`, \`reason\` FROM \`PlatformCollectionPolicy\`
      WHERE \`code\` = ${PLATFORM_POLICY_CODE} FOR SHARE
    `);
    if (platform?.status === 'PAUSED') {
      throw new BizException(ErrorCode.COLLECTION_PAUSED, platform.reason ?? undefined);
    }
    const [tenant] = await tx.$queryRaw<PolicyRow[]>(Prisma.sql`
      SELECT \`status\`, \`reason\` FROM \`TenantCollectionPolicy\`
      WHERE \`tenantId\` = ${tenantId} FOR SHARE
    `);
    if (tenant?.status === 'PAUSED') {
      throw new BizException(ErrorCode.COLLECTION_PAUSED, tenant.reason ?? undefined);
    }
    for (const communityId of communityIds) {
      const [community] = await tx.$queryRaw<PolicyRow[]>(Prisma.sql`
        SELECT \`status\`, \`reason\` FROM \`CommunityCollectionPolicy\`
        WHERE \`tenantId\` = ${tenantId} AND \`communityId\` = ${communityId} FOR SHARE
      `);
      if (community?.status === 'PAUSED') {
        throw new BizException(ErrorCode.COLLECTION_PAUSED, community.reason ?? undefined);
      }
    }
  }

  /** 管理端读取本租户的分层策略与有效状态 */
  async getPolicies(tenantId: string) {
    const [platform, tenant, communities] = await Promise.all([
      this.prisma.raw.platformCollectionPolicy.findUnique({ where: { code: PLATFORM_POLICY_CODE } }),
      this.prisma.raw.tenantCollectionPolicy.findUnique({ where: { tenantId } }),
      this.prisma.raw.communityCollectionPolicy.findMany({ where: { tenantId } }),
    ]);
    return {
      platform: platform ? { status: platform.status, reason: platform.reason, changedAt: platform.changedAt, resumeAt: platform.resumeAt } : { status: 'OPEN' },
      tenant: tenant ? { status: tenant.status, reason: tenant.reason, changedAt: tenant.changedAt, resumeAt: tenant.resumeAt } : { status: 'OPEN' },
      communities: communities.map((c) => ({
        communityId: c.communityId,
        status: c.status,
        reason: c.reason,
        changedAt: c.changedAt,
        resumeAt: c.resumeAt,
      })),
    };
  }

  /** 平台层变更：仅超管；平台策略无所属租户，自审计于策略行（changedBy/reason）。 */
  async setPlatformPolicy(input: SetPlatformPolicyInput) {
    this.assertReason(input.reason);
    const now = new Date();
    return this.prisma.raw.platformCollectionPolicy.upsert({
      where: { code: PLATFORM_POLICY_CODE },
      create: {
        code: PLATFORM_POLICY_CODE,
        name: '全局收款开关',
        status: input.status,
        changedBy: input.adminId,
        reason: input.reason,
        changedAt: now,
        resumeAt: input.resumeAt ?? null,
      },
      update: {
        status: input.status,
        changedBy: input.adminId,
        reason: input.reason,
        changedAt: now,
        resumeAt: input.resumeAt ?? null,
      },
    });
  }

  /** 租户层变更：任意在职物业管理员即视为确认；事务内写审计。 */
  async setTenantPolicy(input: SetTenantPolicyInput) {
    this.assertReason(input.reason);
    const now = new Date();
    return this.prisma.raw.$transaction(async (tx) => {
      const before = await tx.tenantCollectionPolicy.findUnique({ where: { tenantId: input.tenantId } });
      const policy = await tx.tenantCollectionPolicy.upsert({
        where: { tenantId: input.tenantId },
        create: {
          tenantId: input.tenantId,
          status: input.status,
          changedBy: input.adminId,
          reason: input.reason,
          changedAt: now,
          resumeAt: input.resumeAt ?? null,
        },
        update: {
          status: input.status,
          changedBy: input.adminId,
          reason: input.reason,
          changedAt: now,
          resumeAt: input.resumeAt ?? null,
        },
      });
      await this.audit.append(
        {
          tenantId: input.tenantId,
          actorType: 'ADMIN',
          actorId: input.adminId,
          action: 'UPDATE',
          resourceType: 'TenantCollectionPolicy',
          resourceId: policy.id,
          reason: input.reason,
          requestId: input.requestId ?? null,
          beforeSummary: before ? { status: before.status } : null,
          afterSummary: { status: policy.status, resumeAt: policy.resumeAt },
        },
        tx,
      );
      return policy;
    });
  }

  /** 小区层变更：任意在职物业管理员即视为确认；事务内写审计。 */
  async setCommunityPolicy(input: SetCommunityPolicyInput) {
    this.assertReason(input.reason);
    const now = new Date();
    return this.prisma.raw.$transaction(async (tx) => {
      const where = {
        tenantId_communityId: { tenantId: input.tenantId, communityId: input.communityId },
      };
      const before = await tx.communityCollectionPolicy.findUnique({ where });
      const policy = await tx.communityCollectionPolicy.upsert({
        where,
        create: {
          tenantId: input.tenantId,
          communityId: input.communityId,
          status: input.status,
          changedBy: input.adminId,
          reason: input.reason,
          changedAt: now,
          resumeAt: input.resumeAt ?? null,
        },
        update: {
          status: input.status,
          changedBy: input.adminId,
          reason: input.reason,
          changedAt: now,
          resumeAt: input.resumeAt ?? null,
        },
      });
      await this.audit.append(
        {
          tenantId: input.tenantId,
          communityId: input.communityId,
          actorType: 'ADMIN',
          actorId: input.adminId,
          action: 'UPDATE',
          resourceType: 'CommunityCollectionPolicy',
          resourceId: policy.id,
          reason: input.reason,
          requestId: input.requestId ?? null,
          beforeSummary: before ? { status: before.status } : null,
          afterSummary: { status: policy.status, resumeAt: policy.resumeAt },
        },
        tx,
      );
      return policy;
    });
  }
}
