import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ErrorCode, PASS_STATUS_CN, cn } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { pageArgs, pageResult, PageQuery } from '../common/pagination';
import { OwnerHousesService } from '../owner/owner-houses.controller';
import { PrismaService } from '../prisma/prisma.service';

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 北京时间的今天（YYYY-MM-DD）。用固定 +8 偏移而不是 Intl：与小程序侧口径一致 */
export function shanghaiToday(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 存库的 visitDate → 它表示的北京日。
 *
 * visitDate 存的是「该日期在服务器本地时区的零点」。+8 之后取日期部分，
 * 在 UTC 容器（00:00Z → 08:00Z）和 Asia/Shanghai 容器（16:00Z 前一日 → 00:00Z 当日）
 * 下都落在同一天，所以这个换算对两种部署都成立，
 * 也与展示侧 fmtDate 的 +8 口径完全一致。
 */
export function passShanghaiDay(visitDate: Date): string {
  return new Date(visitDate.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 北京今日对应的存库零点值，用于 visitDate 的范围比较 */
function shanghaiTodayStoredBound(now = Date.now()): Date {
  const [y, m, d] = shanghaiToday(now).split('-').map(Number);
  return new Date(y, m - 1, d);
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
      // 与卡券核销码同一处理：物业凭码放行，可预测的随机源没有保留的理由
      const code = String(randomInt(100000, 1000000));
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
    // 按服务器本地日期构造 Date。存储语义保持不变 —— 改成 +08:00 偏移会让新旧行在
    // 范围查询里不一致（旧行是容器时区的零点），而展示侧统一按 +8 取日，两者都对得上。
    const [vy, vm, vd] = dto.visitDate.split('-').map(Number);
    const visitDate = new Date(vy, (vm || 1) - 1, vd || 1);
    if (Number.isNaN(visitDate.getTime())) throw new BizException(ErrorCode.VALIDATION, 'visitDate 非法');
    /*
     * 「不早于今天」按**北京日**比较，不能用服务器本地日。
     *
     * 原写法是 `visitDate < dayStart(new Date())`，注释说是为了避免西向时区误判 ——
     * 但生产容器跑在 UTC，所谓「本地」就是 UTC。北京时间凌晨 0~8 点时 UTC 还是前一天，
     * 于是那几个小时里业主可以为**昨天**（北京）建通行码：物业当天核销不了，
     * 只能人工作废，而业主以为自己约好了。
     *
     * 用字符串比 YYYY-MM-DD：同格式的日期串按字典序比较等价于按日期比较，
     * 不引入任何时区转换，也就没有转换写错的可能。
     */
    if (dto.visitDate < shanghaiToday()) {
      throw new BizException(ErrorCode.VALIDATION, '到访日期不能早于今天');
    }

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
      // 边界按北京日算：用服务器本地日的话，北京 0~8 点这几小时里
      // 昨天（北京）的码还不会被标过期，而它已经不能用了
      where: { ...where, status: 'ACTIVE', visitDate: { lt: shanghaiTodayStoredBound() } },
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
    if (pass.status !== 'ACTIVE')
      throw new BizException(ErrorCode.PASS_STATE_INVALID, `该通行码${cn(PASS_STATUS_CN, pass.status)}，不可使用`);
    /*
     * 「是否当日」必须按北京日比较。
     *
     * 原写法两边都用服务器本地日（生产容器是 UTC）：北京时间 0:00~8:00 之间
     * UTC 还是前一天，于是**当天有效的通行码会被判成「不在有效日期」**——
     * 访客在门口被拦下，而业主明明约的是今天。反过来，昨天的码在那几个小时里还能过。
     * 夜班、晚归、清早送货都落在这个窗口里，不是边角情况。
     */
    if (passShanghaiDay(pass.visitDate) !== shanghaiToday()) {
      throw new BizException(ErrorCode.PASS_STATE_INVALID, '不在有效日期');
    }
    /*
     * 状态流转用条件更新，不能「查到 ACTIVE 再无条件 update」——
     * 两个岗亭同时扫同一个码，两次都查到 ACTIVE、两次 update 都成功，两个人都进来了。
     * 卡券核销刚修的是同一个形状（支付侧的 consumeCouponInTx 一直是对的）。
     */
    const usedAt = new Date();
    const done = await this.prisma.t.visitorPass.updateMany({
      where: { id, status: 'ACTIVE' },
      data: { status: 'USED', usedAt },
    });
    if (done.count !== 1) {
      throw new BizException(ErrorCode.PASS_STATE_INVALID, '该通行码刚刚已被核销，请刷新后重试');
    }
    return { ...pass, status: 'USED' as const, usedAt };
  }
}
