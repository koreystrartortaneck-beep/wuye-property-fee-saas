import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { OwnerHousesService } from '../owner/owner-houses.controller';
import { PrismaService } from '../prisma/prisma.service';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符

/** 卡券：物业自发券（物业费抵扣/服务券/礼品券），业主领取生成核销码，物业核销 */
@Injectable()
export class CouponsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly houses: OwnerHousesService,
  ) {}

  private async genCode(tenantId: string): Promise<string> {
    for (let i = 0; i < 12; i++) {
      let code = '';
      for (let j = 0; j < 8; j++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      const exists = await this.prisma.raw.userCoupon.findFirst({ where: { tenantId, code } });
      if (!exists) return code;
    }
    throw new BizException(ErrorCode.INTERNAL, '核销码生成失败，请重试');
  }

  // ---------- 业主侧 ----------

  /** 当前房屋小区可领取的券（含公司通用券，未领完、在有效期内） */
  async available(ownerId: string, houseId: string) {
    await this.houses.assertOwnerHouse(ownerId, houseId);
    const house = await this.prisma.raw.house.findUnique({ where: { id: houseId } });
    const now = new Date();
    const coupons = await this.prisma.raw.coupon.findMany({
      where: {
        tenantId: house!.tenantId,
        enabled: true,
        validFrom: { lte: now },
        validTo: { gte: now },
        OR: [{ communityId: house!.communityId }, { communityId: null }],
      },
      orderBy: { createdAt: 'desc' },
    });
    // 标注该用户已领数量
    const claimed = await this.prisma.raw.userCoupon.groupBy({
      by: ['couponId'],
      where: { wxUserId: ownerId, couponId: { in: coupons.map((c) => c.id) } },
      _count: { _all: true },
    });
    const claimedMap = new Map(claimed.map((c) => [c.couponId, c._count._all]));
    return coupons.map((c) => ({
      ...c,
      remaining: Math.max(0, c.totalQty - c.claimedQty),
      claimedByMe: claimedMap.get(c.id) ?? 0,
    }));
  }

  async claim(ownerId: string, couponId: string) {
    const coupon = await this.prisma.raw.coupon.findUnique({ where: { id: couponId } });
    if (!coupon || !coupon.enabled) throw new BizException(ErrorCode.NOT_FOUND);
    const now = new Date();
    if (coupon.validFrom > now || coupon.validTo < now) throw new BizException(ErrorCode.COUPON_STATE_INVALID, '不在领取时间');
    // 归属校验：本人须有该租户 ACTIVE 绑定
    const binding = await this.prisma.raw.houseBinding.findFirst({
      where: { wxUserId: ownerId, tenantId: coupon.tenantId, status: 'ACTIVE' },
    });
    if (!binding) throw new BizException(ErrorCode.NO_BINDING);

    const mine = await this.prisma.raw.userCoupon.count({ where: { couponId, wxUserId: ownerId } });
    if (mine >= coupon.perUserLimit) throw new BizException(ErrorCode.COUPON_LIMIT_REACHED);

    const code = await this.genCode(coupon.tenantId);
    // 事务：库存 +1 且不超发，再建领取记录
    return this.prisma.raw.$transaction(async (tx) => {
      const upd = await tx.coupon.updateMany({
        where: { id: couponId, claimedQty: { lt: coupon.totalQty } },
        data: { claimedQty: { increment: 1 } },
      });
      if (upd.count === 0) throw new BizException(ErrorCode.COUPON_SOLD_OUT);
      return tx.userCoupon.create({
        data: { tenantId: coupon.tenantId, couponId, wxUserId: ownerId, code },
      });
    });
  }

  async myCoupons(ownerId: string, q: PageQuery) {
    const where = { wxUserId: ownerId };
    const [rows, total] = await Promise.all([
      this.prisma.raw.userCoupon.findMany({
        where,
        ...pageArgs(q),
        orderBy: { claimedAt: 'desc' },
        include: { coupon: true },
      }),
      this.prisma.raw.userCoupon.count({ where }),
    ]);
    const now = new Date();
    const list = rows.map((uc) => ({
      id: uc.id,
      code: uc.code,
      status: uc.status !== 'USED' && uc.coupon.validTo < now ? 'EXPIRED' : uc.status,
      claimedAt: uc.claimedAt,
      usedAt: uc.usedAt,
      coupon: {
        name: uc.coupon.name,
        type: uc.coupon.type,
        faceValue: uc.coupon.faceValue,
        threshold: uc.coupon.threshold,
        description: uc.coupon.description,
        validTo: uc.coupon.validTo,
      },
    }));
    return pageResult(list, total, q);
  }

  // ---------- 管理侧 ----------

  async adminList(q: PageQuery & { communityId?: string }) {
    const where = q.communityId ? { OR: [{ communityId: q.communityId }, { communityId: null }] } : {};
    const [list, total] = await Promise.all([
      this.prisma.t.coupon.findMany({ where, ...pageArgs(q), orderBy: { createdAt: 'desc' } }),
      this.prisma.t.coupon.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  /** 按核销码核销 */
  async verify(code: string) {
    const uc = await this.prisma.t.userCoupon.findFirst({ where: { code }, include: { coupon: true } });
    if (!uc) throw new BizException(ErrorCode.NOT_FOUND, '未找到该券');
    if (uc.status === 'USED') throw new BizException(ErrorCode.COUPON_STATE_INVALID, '该券已核销');
    if (uc.coupon.validTo < new Date()) throw new BizException(ErrorCode.COUPON_STATE_INVALID, '该券已过期');
    return this.prisma.t.userCoupon.update({ where: { id: uc.id }, data: { status: 'USED', usedAt: new Date() } });
  }

  async findByCode(code: string) {
    const uc = await this.prisma.t.userCoupon.findFirst({ where: { code }, include: { coupon: true } });
    if (!uc) throw new BizException(ErrorCode.NOT_FOUND, '未找到该券');
    return uc;
  }
}
