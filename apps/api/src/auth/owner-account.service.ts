import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';

/**
 * 业主账号注销（Task 12）：
 * - 匿名化身份字段（openid/unionid/phone/nickname），递增 tokenVersion 吊销全部旧令牌；
 * - 解除全部活跃/待审绑定并标记撤销，写审计；
 * - 绝不删除财务、退款、发票、对账、审计等记录（法务/对账留痕）。
 */
@Injectable()
export class OwnerAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async deleteAccount(ownerId: string): Promise<{ deleted: true }> {
    const user = await this.prisma.raw.wxUser.findUnique({ where: { id: ownerId } });
    if (!user || user.deletedAt) throw new BizException(ErrorCode.NOT_FOUND, '账号不存在或已注销');

    const now = new Date();
    const bindings = await this.prisma.raw.houseBinding.findMany({
      where: { wxUserId: ownerId, status: { in: ['ACTIVE', 'PENDING'] } },
    });

    await this.prisma.raw.$transaction(async (tx) => {
      await tx.houseBinding.updateMany({
        where: { wxUserId: ownerId, status: { in: ['ACTIVE', 'PENDING'] } },
        data: { status: 'REJECTED', revokedAt: now, revokeReason: '业主注销账号' },
      });
      await tx.wxUser.update({
        where: { id: ownerId },
        data: {
          openid: `deleted:${ownerId}`,
          unionid: null,
          phone: null,
          nickname: null,
          deletedAt: now,
          tokenVersion: { increment: 1 },
        },
      });
      for (const b of bindings) {
        await runWithTenant(b.tenantId, () =>
          this.audit.append(
            {
              tenantId: b.tenantId,
              actorType: 'WX_USER',
              actorId: ownerId,
              action: 'CANCEL',
              resourceType: 'HouseBinding',
              resourceId: b.id,
              afterSummary: { event: 'ACCOUNT_DELETE_UNBIND', status: 'REJECTED' },
            },
            tx as never,
          ),
        );
      }
    });

    return { deleted: true };
  }
}
