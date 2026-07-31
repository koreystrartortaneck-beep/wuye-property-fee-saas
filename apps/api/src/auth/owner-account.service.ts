import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCode } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';

/**
 * 业主账号注销（Task 12）：
 * - 匿名化身份字段（openid/unionid/phone/nickname），递增 tokenVersion 吊销全部旧令牌；
 * - 匿名化**关联表里的个人信息**（见下）；
 * - 解除全部活跃/待审绑定并标记撤销，写审计；
 * - 绝不删除财务、退款、发票、对账、审计等记录（法务/对账留痕）。
 *
 * 关于关联表：原实现只清了 WxUser 自身的四个字段，而下列个人信息仍然可以用
 * wxUserId 反查出来——注销后依然能还原出这个人的姓名、手机号、房号、车牌：
 *   HouseBinding.applicantName        业主申请绑定时填的真实姓名
 *   ServiceOrder.contactName/Phone    上门服务的联系人姓名与手机号
 *   VisitorPass.visitorName/Phone/plateNo  访客姓名、手机号、车牌
 *   Payment.offlinePayerSnapshot.payerName  线下付款人姓名
 * 这不符合《个人信息保护法》第 47 条的删除义务，也不符合小程序注销功能的通常审核口径。
 *
 * 取舍：
 * · 业务记录本身**保留**（工单历史、服务单、通行记录对物业仍有管理价值，
 *   且删掉会让统计与审计断裂），只把可识别身份的字段置空或替换为占位；
 * · Ticket.content 是业主自己写的报修描述，保留（物业要据此追溯处理过程），
 *   但清空 images —— 照片可能拍到户内、门牌、身份材料，而文字不会；
 * · Payment.offlinePayerSnapshot 属财务凭证，姓名改存脱敏形式（张*）而不是清空：
 *   完全清空会让线下收款失去可核对的付款人，而全名保留又与隐私政策的说法冲突。
 * · 财务主体（Payment/Refund/Bill/InvoiceApplication）与 AuditLog 一律不动。
 */
/** 匿名化占位值。用固定文案而不是 null：这些列是 NOT NULL，且界面上要能看出「已注销」 */
const ANONYMIZED_NAME = '已注销业主';
const ANONYMIZED_PHONE = '';

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

      /*
       * 关联表里的个人信息一并匿名化，且必须在同一事务内——
       * 分开做会留下「身份已清、姓名还在」的中间态，若后一步失败就永久残留。
       * 注意 updateMany 覆盖该用户**全部**绑定（含历史 REJECTED 的），
       * 不能只清上面那批 ACTIVE/PENDING。
       */
      await tx.houseBinding.updateMany({
        where: { wxUserId: ownerId },
        data: { applicantName: null },
      });
      await tx.serviceOrder.updateMany({
        where: { wxUserId: ownerId },
        data: { contactName: ANONYMIZED_NAME, contactPhone: ANONYMIZED_PHONE },
      });
      await tx.visitorPass.updateMany({
        where: { wxUserId: ownerId },
        data: { visitorName: ANONYMIZED_NAME, visitorPhone: null, plateNo: null },
      });
      // 报修文字保留（物业要据此追溯处理过程），但清空照片：可能拍到户内/门牌/身份材料
      await tx.ticket.updateMany({
        where: { wxUserId: ownerId },
        // Json 列用 InputJsonValue 而不是 never：never 连「是不是可序列化的 JSON」都不检查
        data: { images: [] as Prisma.InputJsonValue },
      });
      await this.anonymizeOfflinePayerNames(tx, ownerId);
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
            tx,
          ),
        );
      }
    });

    return { deleted: true };
  }

  /**
   * 线下付款人姓名改存脱敏形式。
   *
   * 这是财务凭证的一部分（Payment.offlinePayerSnapshot），完全清空会让线下收款
   * 失去可核对的付款人；而保留全名又与隐私政策里「保留财务凭证但不含可识别身份信息」
   * 的说法冲突。折中为「张*」：仍能与纸质回单对上，但不足以识别到人。
   *
   * 逐条改而不是 updateMany：payerName 在 Json 列内部，需要读出来改再写回。
   * 单个业主的线下缴费笔数是个位数到几十，逐条可接受。
   */
  private async anonymizeOfflinePayerNames(
    tx: { payment: { findMany: Function; update: Function } },
    ownerId: string,
  ): Promise<void> {
    const rows = (await tx.payment.findMany({
      where: { wxUserId: ownerId, NOT: { offlinePayerSnapshot: null } },
      select: { id: true, offlinePayerSnapshot: true },
    })) as Array<{ id: string; offlinePayerSnapshot: Record<string, unknown> | null }>;
    for (const r of rows) {
      const snap = r.offlinePayerSnapshot;
      if (!snap || typeof snap.payerName !== 'string' || !snap.payerName) continue;
      await tx.payment.update({
        where: { id: r.id },
        data: {
          offlinePayerSnapshot: { ...snap, payerName: maskName(snap.payerName) } as Prisma.InputJsonValue,
        },
      });
    }
  }
}

/** 姓名脱敏：保留姓，其余用 * 代替（张三 → 张*，欧阳修 → 欧**） */
function maskName(name: string): string {
  const chars = [...name.trim()];
  if (chars.length <= 1) return '*';
  return chars[0] + '*'.repeat(chars.length - 1);
}
