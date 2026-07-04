import { Injectable } from '@nestjs/common';
import { ErrorCode, TicketStatus, TicketType } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { pageArgs, pageResult, PageQuery } from '../common/pagination';
import { OwnerHousesService } from '../owner/owner-houses.controller';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 工单服务（报修/投诉/建议共用底座）。
 * 业主侧跨租户 → raw + 绑定校验；管理侧走租户隔离 client。
 * 状态机：PENDING → PROCESSING → DONE；任意 → CLOSED（管理关闭）。
 */
@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly houses: OwnerHousesService,
  ) {}

  // ---------- 业主侧 ----------

  async create(ownerId: string, dto: { houseId: string; type: TicketType; content: string; images: string[] }) {
    await this.houses.assertOwnerHouse(ownerId, dto.houseId);
    const house = await this.prisma.raw.house.findUnique({ where: { id: dto.houseId } });
    return this.prisma.raw.ticket.create({
      data: {
        tenantId: house!.tenantId,
        communityId: house!.communityId,
        houseId: dto.houseId,
        wxUserId: ownerId,
        type: dto.type,
        content: dto.content,
        images: dto.images,
      },
    });
  }

  async myList(ownerId: string, q: PageQuery & { type?: TicketType; status?: TicketStatus }) {
    const where = {
      wxUserId: ownerId,
      ...(q.type ? { type: q.type } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.raw.ticket.findMany({
        where,
        ...pageArgs(q),
        orderBy: { createdAt: 'desc' },
        include: { house: { select: { displayName: true, community: { select: { name: true } } } } },
      }),
      this.prisma.raw.ticket.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  async myDetail(ownerId: string, id: string) {
    const ticket = await this.prisma.raw.ticket.findUnique({
      where: { id },
      include: { house: { select: { displayName: true, community: { select: { name: true } } } } },
    });
    if (!ticket || ticket.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
    return ticket;
  }

  async rate(ownerId: string, id: string, rating: number, comment?: string) {
    const ticket = await this.prisma.raw.ticket.findUnique({ where: { id } });
    if (!ticket || ticket.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
    if (ticket.status !== 'DONE') throw new BizException(ErrorCode.TICKET_STATE_INVALID, '仅已办结工单可评价');
    if (ticket.rating !== null) throw new BizException(ErrorCode.TICKET_STATE_INVALID, '已评价过');
    return this.prisma.raw.ticket.update({
      where: { id },
      data: { rating, ratingComment: comment ?? null },
    });
  }

  // ---------- 管理侧（租户隔离 client） ----------

  async adminList(q: PageQuery & { communityId?: string; type?: TicketType; status?: TicketStatus }) {
    const where = {
      ...(q.communityId ? { communityId: q.communityId } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.t.ticket.findMany({
        where,
        ...pageArgs(q),
        orderBy: { createdAt: 'desc' },
        include: {
          house: { select: { displayName: true, code: true } },
          wxUser: { select: { phone: true } },
        },
      }),
      this.prisma.t.ticket.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  private async mustGet(id: string) {
    const ticket = await this.prisma.t.ticket.findUnique({ where: { id } });
    if (!ticket) throw new BizException(ErrorCode.NOT_FOUND);
    return ticket;
  }

  async process(id: string, assigneeName: string) {
    const ticket = await this.mustGet(id);
    if (ticket.status !== 'PENDING') throw new BizException(ErrorCode.TICKET_STATE_INVALID, '仅待受理工单可派单');
    return this.prisma.t.ticket.update({
      where: { id },
      data: { status: 'PROCESSING', assigneeName, processedAt: new Date() },
    });
  }

  async done(id: string, replyContent: string) {
    const ticket = await this.mustGet(id);
    if (ticket.status !== 'PROCESSING') throw new BizException(ErrorCode.TICKET_STATE_INVALID, '仅处理中工单可办结');
    return this.prisma.t.ticket.update({
      where: { id },
      data: { status: 'DONE', replyContent, doneAt: new Date() },
    });
  }

  async close(id: string) {
    const ticket = await this.mustGet(id);
    if (ticket.status === 'DONE' || ticket.status === 'CLOSED') {
      throw new BizException(ErrorCode.TICKET_STATE_INVALID, '该工单已结束');
    }
    return this.prisma.t.ticket.update({ where: { id }, data: { status: 'CLOSED' } });
  }
}
