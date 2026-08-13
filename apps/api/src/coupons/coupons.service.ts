import { randomInt } from 'node:crypto';
import * as QRCode from 'qrcode';
import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { OwnerHousesService } from '../owner/owner-houses.controller';
import { PrismaService } from '../prisma/prisma.service';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符

/** Prisma 的唯一约束冲突。不用 instanceof：测试里的模拟错误也要能被识别 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/** 卡券：物业自发券（物业费抵扣/服务券/礼品券），业主领取生成核销码，物业核销 */
@Injectable()
export class CouponsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly houses: OwnerHousesService,
  ) {}

  /**
   * 生成核销码。
   *
   * 用 crypto.randomInt 而不是 Math.random：核销只凭码、不校验持有人身份
   * （物业扫到码就发货），而 V8 的 Math.random 是 xorshift128+，
   * 看到自己的若干个码就能反推内部状态、进而预测别人的码 —— 拿别人的礼品券去兑。
   * 概率上难做，但换个函数就没这个面，没有不换的理由。
   */
  private async genCode(tenantId: string): Promise<string> {
    for (let i = 0; i < 12; i++) {
      let code = '';
      for (let j = 0; j < 8; j++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
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

    /*
     * 限领的**硬保证在数据库**：UserCoupon 上有 @@unique([couponId, wxUserId, claimSeq])。
     *
     * 原实现是事务外 count 一次再进事务 —— 典型的 TOCTOU：
     * 同一用户并发两次领取都读到 count=0（limit=1），都通过校验，各自建一条记录，
     * 拿到超额的券。而每张券都是实打实的抵扣金额。
     * 库存那道本来就有原子保证（claimedQty < totalQty 的条件 updateMany），
     * 唯独限领这道靠读后写，是全链路里最弱的一环。
     *
     * 现在按 claimSeq = 0..perUserLimit-1 逐个尝试插入，撞唯一约束就换下一个序号；
     * 全部占满才报「已达上限」。并发时必有一方拿到 P2002，无法超发。
     */
    for (let seq = 0; seq < coupon.perUserLimit; seq++) {
      const code = await this.genCode(coupon.tenantId);
      try {
        return await this.prisma.raw.$transaction(async (tx) => {
          const upd = await tx.coupon.updateMany({
            where: { id: couponId, claimedQty: { lt: coupon.totalQty } },
            data: { claimedQty: { increment: 1 } },
          });
          if (upd.count === 0) throw new BizException(ErrorCode.COUPON_SOLD_OUT);
          return tx.userCoupon.create({
            data: { tenantId: coupon.tenantId, couponId, wxUserId: ownerId, code, claimSeq: seq },
          });
        });
      } catch (e) {
        /*
         * P2002 = 唯一约束冲突。两种可能：这个序号已被自己占了（顺延即可），
         * 或核销码撞了（极低概率，同样顺延重生成）。
         * 库存不足抛的是 BizException，不能被这里吞掉 —— 必须原样抛出，
         * 否则「售完」会被误报成「已达上限」，业主看到的原因是错的。
         */
        if (!isUniqueViolation(e)) throw e;
      }
    }
    throw new BizException(ErrorCode.COUPON_LIMIT_REACHED);
  }

  /*
   * 亮码核销:券码渲染成二维码。内容带 PFC: 前缀 —— 员工端扫到不带前缀的码
   * (随便什么付款码/网址)会明确拒绝,不会拿别人的字符串去撞券库。
   * 只给「本人、未使用」的券出码:已核销/过期的券出码只会让前台空欢喜一场。
   */
  async myCouponQr(ownerId: string, id: string) {
    const uc = await this.prisma.raw.userCoupon.findFirst({ where: { id, wxUserId: ownerId }, include: { coupon: true } });
    if (!uc) throw new BizException(ErrorCode.NOT_FOUND, '未找到该券');
    if (uc.status === 'USED') throw new BizException(ErrorCode.COUPON_STATE_INVALID, '该券已核销');
    if (uc.coupon.validTo < new Date()) throw new BizException(ErrorCode.COUPON_STATE_INVALID, '该券已过期');
    const dataUrl = await QRCode.toDataURL(`PFC:${uc.code}`, { margin: 1, width: 480 });
    return { code: uc.code, name: uc.coupon.name, dataUrl };
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

  /**
   * 按核销码核销。
   *
   * 状态流转用条件 updateMany + count 校验，不能「先查 UNUSED 再 update」——
   * 那是读后写：两个收银台同时扫同一张礼品券，两次都查到 UNUSED、两次都 update 成功，
   * 东西发两份。支付侧的 consumeCouponInTx 本来就是这么做的（乐观锁），
   * 这里漏了同一份保护。
   */
  async verify(code: string) {
    const uc = await this.prisma.t.userCoupon.findFirst({ where: { code }, include: { coupon: true } });
    if (!uc) throw new BizException(ErrorCode.NOT_FOUND, '未找到该券');
    if (uc.status === 'USED') throw new BizException(ErrorCode.COUPON_STATE_INVALID, '该券已核销');
    if (uc.coupon.validTo < new Date()) throw new BizException(ErrorCode.COUPON_STATE_INVALID, '该券已过期');

    const now = new Date();
    const done = await this.prisma.t.userCoupon.updateMany({
      where: { id: uc.id, status: 'UNUSED' },
      data: { status: 'USED', usedAt: now },
    });
    if (done.count !== 1) {
      // 与支付侧同一套文案口径：告诉物业「刚刚被核销了」，而不是含糊的「操作失败」
      throw new BizException(ErrorCode.COUPON_STATE_INVALID, '该券刚刚已被核销，请刷新后重试');
    }
    return { ...uc, status: 'USED' as const, usedAt: now };
  }

  async findByCode(code: string) {
    const uc = await this.prisma.t.userCoupon.findFirst({ where: { code }, include: { coupon: true } });
    if (!uc) throw new BizException(ErrorCode.NOT_FOUND, '未找到该券');
    return uc;
  }
}
