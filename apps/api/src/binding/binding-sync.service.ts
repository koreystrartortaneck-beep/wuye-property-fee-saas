import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';

/*
 * 绑定联动的唯一实现。
 *
 * 「手机号 ↔ 房屋 ↔ 微信用户」这组联动有四个入口:
 *   业主自己授权手机号(bindPhone)、物业加号、物业删号、批量导入。
 * 四处必须是同一份规则 —— 尤其是「人工审批过的绑定不被手机匹配覆盖」这条,
 * 在任何一处漏掉都会静默改写审批证据。所以抽成一个服务,谁都不许自己再写一遍。
 *
 * 本次重构的根修复也在这里:原来自动解绑只在**业主自己重新授权**时触发
 * (auth.service.ts 的 bindPhone),后台改手机号完全不触碰绑定 ——
 * 换租后前住户继续看得到现住户的账单。现在物业删号在同一事务里立即撤销绑定。
 */

/** $transaction 回调里的事务客户端;raw client 结构兼容,导入等非事务场景可直接传 */
export type TxLike = Parameters<Parameters<PrismaService['raw']['$transaction']>[0]>[0];

export interface BindingChannelConfig {
  phoneMatch: boolean;
  selfApply: boolean;
  selfApplyNeedsApproval: boolean;
}

/** 缺行 = 全默认:渠道全开、自助申请需审批(与 TenantCollectionPolicy 的懒解析同款) */
export const DEFAULT_BINDING_CONFIG: BindingChannelConfig = {
  phoneMatch: true,
  selfApply: true,
  selfApplyNeedsApproval: true,
};

export interface BindingActor {
  type: 'WX_USER' | 'ADMIN';
  id: string;
}

interface HouseRef {
  id: string;
  tenantId: string;
  communityId?: string | null;
  code?: string | null;
}

@Injectable()
export class BindingSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getConfig(tenantId: string): Promise<BindingChannelConfig> {
    const row = await this.prisma.raw.tenantBindingConfig.findUnique({ where: { tenantId } });
    if (!row) return { ...DEFAULT_BINDING_CONFIG };
    return {
      phoneMatch: row.phoneMatch,
      selfApply: row.selfApply,
      selfApplyNeedsApproval: row.selfApplyNeedsApproval,
    };
  }

  /**
   * 命中房屋 → 建立/复活 PHONE_MATCH 绑定。
   *
   * 规则(自 bindPhone 原样抽出,行为不变):
   *   · 无绑定 → 建 ACTIVE PHONE_MATCH
   *   · source=APPLY 或已有 reviewedBy(人工审批证据)→ 不动
   *   · 失效的 PHONE_MATCH → 复活(清 revokedAt/revokeReason)
   *
   * actor 决定审计署名:业主自己授权是 WX_USER,物业加号是 ADMIN ——
   * 同一个动作、两种触发者,审计必须分得清是谁干的。
   */
  async applyPhoneMatch(tx: TxLike, wxUserId: string, houses: HouseRef[], now: Date, actor: BindingActor): Promise<number> {
    if (houses.length === 0) return 0;
    const existing = await tx.houseBinding.findMany({
      where: { wxUserId, houseId: { in: houses.map((h) => h.id) } },
    });
    const byHouse = new Map(existing.map((b) => [b.houseId, b]));
    let activated = 0;

    for (const house of houses) {
      const cur = byHouse.get(house.id);
      if (!cur) {
        const created = await tx.houseBinding.create({
          data: {
            tenantId: house.tenantId,
            wxUserId,
            houseId: house.id,
            relation: 'OWNER',
            status: 'ACTIVE',
            source: 'PHONE_MATCH',
            phoneMatchedAt: now,
          },
        });
        await this.appendBindingAudit(tx, house.tenantId, created.id, actor, 'CREATE', {
          event: 'BINDING_PHONE_MATCH_CREATE',
          source: 'PHONE_MATCH',
          status: 'ACTIVE',
          houseCode: house.code ?? null,
        });
        activated += 1;
        continue;
      }
      // 人工审批(APPLY 或已审核)证据:保留,不被手机匹配改写。
      if (cur.source === 'APPLY' || cur.reviewedBy) continue;
      if (cur.status !== 'ACTIVE' || cur.revokedAt) {
        await tx.houseBinding.updateMany({
          where: { id: cur.id },
          data: { status: 'ACTIVE', source: 'PHONE_MATCH', phoneMatchedAt: now, revokedAt: null, revokeReason: null },
        });
        await this.appendBindingAudit(tx, cur.tenantId, cur.id, actor, 'UPDATE', {
          event: 'BINDING_PHONE_MATCH_REACTIVATE',
          source: 'PHONE_MATCH',
          status: 'ACTIVE',
          houseCode: house.code ?? null,
        });
        activated += 1;
      }
    }
    return activated;
  }

  /**
   * 物业给房屋登记一个授权手机号(加号 = 授权)。
   *
   * 已经授权过手机号的微信用户当场绑上 —— 不等他下次打开小程序;
   * 还没用过小程序的人,号先记着,他授权那一刻由 bindPhone 兜住。
   */
  async grantContact(
    tx: TxLike,
    house: HouseRef,
    phone: string,
    name: string | null,
    source: 'ADMIN' | 'APPLY_APPROVED' | 'IMPORT',
    actor: BindingActor,
  ): Promise<{ contactId: string; activatedBindings: number; created: boolean }> {
    let contact: { id: string };
    let created = true;
    try {
      contact = await tx.houseContact.create({
        data: { tenantId: house.tenantId, houseId: house.id, phone, name, source, createdBy: actor.type === 'ADMIN' ? actor.id : null },
      });
    } catch (e) {
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
        /*
         * 已登记同号:审批联动、导入这类幂等场景直接复用既有行,
         * 手工加号在控制器层会把 created=false 转成明确提示。
         */
        const found = await tx.houseContact.findFirst({ where: { houseId: house.id, phone } });
        if (!found) throw e;
        contact = found;
        created = false;
      } else {
        throw e;
      }
    }

    const users = await tx.wxUser.findMany({ where: { phone, deletedAt: null }, select: { id: true } });
    let activated = 0;
    for (const u of users) {
      activated += await this.applyPhoneMatch(tx, u.id, [house], new Date(), actor);
    }

    if (created) {
      await runWithTenant(house.tenantId, () =>
        this.audit.append(
          {
            tenantId: house.tenantId,
            communityId: house.communityId ?? null,
            actorType: actor.type,
            actorId: actor.id,
            action: 'CREATE',
            resourceType: 'HouseContact',
            resourceId: contact.id,
            // key 含 phone 会被审计层自动脱敏(audit.service.ts 的 redact 词表)
            afterSummary: { event: 'HOUSE_CONTACT_ADD', houseCode: house.code ?? null, phone, source, activatedBindings: activated },
          },
          tx,
        ),
      );
    }
    return { contactId: contact.id, activatedBindings: activated, created };
  }

  /**
   * 物业移除一个授权手机号(删号 = 解绑)。
   *
   * 撤销该房下、当前手机号等于被删号的**全部** ACTIVE 绑定,**不分 source** ——
   * 自洽于「审批通过自动加号」:APPLY 出身的人,他的授权就是那行联系人。
   * (若用户后来在微信侧换了手机号,他的绑定不再与被删号匹配 → 不在此撤销;
   *  他下次授权时 bindPhone 的自动解绑分支会按新号重算。)
   *
   * 不做删前确认(产品决策),但结果必须如实返回:revoked 列表交给调用方展示。
   */
  async revokeContact(
    tx: TxLike,
    house: HouseRef,
    phone: string,
    reason: string,
    actor: BindingActor,
  ): Promise<{ removedContact: boolean; revoked: Array<{ bindingId: string; wxUserId: string }> }> {
    const del = await tx.houseContact.deleteMany({ where: { houseId: house.id, phone } });

    const bindings = await tx.houseBinding.findMany({
      where: { houseId: house.id, status: 'ACTIVE', wxUser: { phone } },
      select: { id: true, wxUserId: true, tenantId: true },
    });
    const now = new Date();
    if (bindings.length > 0) {
      await tx.houseBinding.updateMany({
        where: { id: { in: bindings.map((b) => b.id) } },
        data: { status: 'REJECTED', revokedAt: now, revokeReason: reason },
      });
      for (const b of bindings) {
        await this.appendBindingAudit(tx, b.tenantId, b.id, actor, 'CANCEL', {
          event: 'BINDING_CONTACT_REMOVE_REVOKE',
          status: 'REJECTED',
          houseCode: house.code ?? null,
          wxUserId: b.wxUserId,
          reason,
        });
      }
    }

    if (del.count > 0) {
      await runWithTenant(house.tenantId, () =>
        this.audit.append(
          {
            tenantId: house.tenantId,
            communityId: house.communityId ?? null,
            actorType: actor.type,
            actorId: actor.id,
            action: 'DELETE',
            resourceType: 'HouseContact',
            resourceId: `${house.id}:${phone}`,
            reason,
            afterSummary: {
              event: 'HOUSE_CONTACT_REMOVE',
              houseCode: house.code ?? null,
              phone,
              revokedBindings: bindings.map((b) => b.wxUserId),
            },
          },
          tx,
        ),
      );
    }
    return { removedContact: del.count > 0, revoked: bindings.map((b) => ({ bindingId: b.id, wxUserId: b.wxUserId })) };
  }

  /** 中国大陆手机号;匹配只可能命中微信授权回来的真实手机号,别的格式登记了也白登 */
  assertMobile(phone: string): void {
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      throw new BizException(ErrorCode.VALIDATION, '请填写 11 位大陆手机号(与业主微信绑定的号码一致才能自动匹配)');
    }
  }

  private appendBindingAudit(
    tx: TxLike,
    tenantId: string,
    bindingId: string,
    actor: BindingActor,
    action: 'CREATE' | 'UPDATE' | 'CANCEL',
    summary: Record<string, unknown>,
  ): Promise<unknown> {
    return runWithTenant(tenantId, () =>
      this.audit.append(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id,
          action,
          resourceType: 'HouseBinding',
          resourceId: bindingId,
          afterSummary: summary,
        },
        tx,
      ),
    );
  }
}
