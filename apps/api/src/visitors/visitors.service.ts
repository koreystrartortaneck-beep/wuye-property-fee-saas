import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { pageArgs, pageResult, PageQuery } from '../common/pagination';
import { OwnerHousesService } from '../owner/owner-houses.controller';
import { PrismaService } from '../prisma/prisma.service';

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 访客通行证：业主生成 6 位通行码，物业当日核销；过期懒标记 */
@Injectable()
export class VisitorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly houses: OwnerHousesService,
  ) {}

  /** 生成租户内不重复的 6 位数字码 */
  private async genCode(tenantId: string): Promise<string> {
    for (let i = 0; i < 10; i++) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const exists = await this.prisma.raw.visitorPass.findFirst({ where: { tenantId, code } });
      if (!exists) return code;
    }
    throw new BizException(ErrorCode.INTERNAL, '通行码生成失败，请重试');
  }

  async create(
    ownerId: string,
    dto: { houseId: string; visitorName: string; visitorPhone?: string; plateNo?: string; visitDate: string },
  ) {
    await this.houses.assertOwnerHouse(ownerId, dto.houseId);
    // 按本地日期解析 YYYY-MM-DD（避免 new Date 把纯日期当 UTC，导致西向时区误判"早于今天"）
    const [vy, vm, vd] = dto.visitDate.split('-').map(Number);
    const visitDate = new Date(vy, (vm || 1) - 1, vd || 1);
    if (Number.isNaN(visitDate.getTime())) throw new BizException(ErrorCode.VALIDATION, 'visitDate 非法');
    if (visitDate < dayStart(new Date())) throw new BizException(ErrorCode.VALIDATION, '到访日期不能早于今天');

    const house = await this.prisma.raw.house.findUnique({ where: { id: dto.houseId } });
    const code = await this.genCode(house!.tenantId);
    return this.prisma.raw.visitorPass.create({
      data: {
        tenantId: house!.tenantId,
        communityId: house!.communityId,
        houseId: dto.houseId,
        wxUserId: ownerId,
        visitorName: dto.visitorName,
        visitorPhone: dto.visitorPhone,
        plateNo: dto.plateNo,
        visitDate,
        code,
      },
    });
  }

  /** 查询时把已过期的 ACTIVE 懒标记为 EXPIRED */
  private async lazyExpire(where: object): Promise<void> {
    await this.prisma.raw.visitorPass.updateMany({
      where: { ...where, status: 'ACTIVE', visitDate: { lt: dayStart(new Date()) } },
      data: { status: 'EXPIRED' },
    });
  }

  async myList(ownerId: string, q: PageQuery) {
    await this.lazyExpire({ wxUserId: ownerId });
    const where = { wxUserId: ownerId };
    const [list, total] = await Promise.all([
      this.prisma.raw.visitorPass.findMany({
        where,
        ...pageArgs(q),
        orderBy: { createdAt: 'desc' },
        include: { house: { select: { displayName: true, community: { select: { name: true } } } } },
      }),
      this.prisma.raw.visitorPass.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  async cancel(ownerId: string, id: string) {
    const pass = await this.prisma.raw.visitorPass.findUnique({ where: { id } });
    if (!pass || pass.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
    if (pass.status !== 'ACTIVE') throw new BizException(ErrorCode.PASS_STATE_INVALID);
    return this.prisma.raw.visitorPass.update({ where: { id }, data: { status: 'CANCELED' } });
  }

  // ---------- 管理侧 ----------

  async adminList(q: PageQuery & { communityId?: string; code?: string; date?: string }) {
    const where = {
      ...(q.communityId ? { communityId: q.communityId } : {}),
      ...(q.code ? { code: q.code } : {}),
      ...(q.date ? { visitDate: dayStart(new Date(q.date)) } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.t.visitorPass.findMany({
        where,
        ...pageArgs(q),
        orderBy: { createdAt: 'desc' },
        include: { house: { select: { displayName: true, code: true } } },
      }),
      this.prisma.t.visitorPass.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  /** 核销：仅当日 ACTIVE 码可核 */
  async verify(id: string) {
    const pass = await this.prisma.t.visitorPass.findUnique({ where: { id } });
    if (!pass) throw new BizException(ErrorCode.NOT_FOUND);
    if (pass.status !== 'ACTIVE') throw new BizException(ErrorCode.PASS_STATE_INVALID, `当前状态 ${pass.status}`);
    const today = dayStart(new Date()).getTime();
    if (dayStart(pass.visitDate).getTime() !== today) {
      throw new BizException(ErrorCode.PASS_STATE_INVALID, '不在有效日期');
    }
    return this.prisma.t.visitorPass.update({
      where: { id },
      data: { status: 'USED', usedAt: new Date() },
    });
  }
}
