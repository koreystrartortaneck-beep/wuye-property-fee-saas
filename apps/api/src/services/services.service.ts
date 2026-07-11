import { Injectable } from '@nestjs/common';
import { ErrorCode, ServiceOrderStatus } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { OwnerHousesService } from '../owner/owner-houses.controller';
import { PrismaService } from '../prisma/prisma.service';

/** 生活服务：物业配置服务菜单，业主预约下单，物业接单上门（简版：不含在线支付） */
@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly houses: OwnerHousesService,
  ) {}

  // ---------- 业主侧 ----------

  /** 当前房屋小区可预约的服务（含公司通用服务） */
  async availableItems(ownerId: string, houseId: string) {
    await this.houses.assertOwnerHouse(ownerId, houseId);
    const house = await this.prisma.raw.house.findUnique({ where: { id: houseId } });
    return this.prisma.raw.serviceItem.findMany({
      where: {
        tenantId: house!.tenantId,
        enabled: true,
        OR: [{ communityId: house!.communityId }, { communityId: null }],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createOrder(
    ownerId: string,
    dto: { houseId: string; serviceItemId: string; contactName: string; contactPhone: string; expectDate: string; remark?: string },
  ) {
    await this.houses.assertOwnerHouse(ownerId, dto.houseId);
    const house = await this.prisma.raw.house.findUnique({ where: { id: dto.houseId } });
    const item = await this.prisma.raw.serviceItem.findUnique({ where: { id: dto.serviceItemId } });
    if (!item || !item.enabled || item.tenantId !== house!.tenantId) {
      throw new BizException(ErrorCode.SERVICE_UNAVAILABLE);
    }
    const expectDate = new Date(dto.expectDate);
    if (Number.isNaN(expectDate.getTime())) throw new BizException(ErrorCode.VALIDATION, 'expectDate 非法');

    return this.prisma.raw.serviceOrder.create({
      data: {
        tenantId: house!.tenantId,
        communityId: house!.communityId,
        houseId: dto.houseId,
        wxUserId: ownerId,
        serviceItemId: item.id,
        serviceName: item.name,
        price: item.price,
        unit: item.unit,
        contactName: dto.contactName,
        contactPhone: dto.contactPhone,
        expectDate,
        remark: dto.remark,
      },
    });
  }

  async myOrders(ownerId: string, q: PageQuery) {
    const where = { wxUserId: ownerId };
    const [list, total] = await Promise.all([
      this.prisma.raw.serviceOrder.findMany({ where, ...pageArgs(q), orderBy: { createdAt: 'desc' } }),
      this.prisma.raw.serviceOrder.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  async cancelOrder(ownerId: string, id: string) {
    const order = await this.prisma.raw.serviceOrder.findUnique({ where: { id } });
    if (!order || order.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
    if (order.status !== 'PENDING') throw new BizException(ErrorCode.SERVICE_ORDER_STATE_INVALID, '已接单/完成的预约不能取消');
    return this.prisma.raw.serviceOrder.update({ where: { id }, data: { status: 'CANCELED' } });
  }

  // ---------- 管理侧 ----------

  async adminOrders(q: PageQuery & { communityId?: string; status?: ServiceOrderStatus }) {
    const where = {
      ...(q.communityId ? { communityId: q.communityId } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.t.serviceOrder.findMany({
        where,
        ...pageArgs(q),
        orderBy: { createdAt: 'desc' },
        include: { house: { select: { displayName: true, code: true } } },
      }),
      this.prisma.t.serviceOrder.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  private async mustGet(id: string) {
    const order = await this.prisma.t.serviceOrder.findUnique({ where: { id } });
    if (!order) throw new BizException(ErrorCode.NOT_FOUND);
    return order;
  }

  async accept(id: string) {
    const order = await this.mustGet(id);
    if (order.status !== 'PENDING') throw new BizException(ErrorCode.SERVICE_ORDER_STATE_INVALID, '仅待接单可接单');
    return this.prisma.t.serviceOrder.update({ where: { id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
  }

  async done(id: string) {
    const order = await this.mustGet(id);
    if (order.status !== 'ACCEPTED') throw new BizException(ErrorCode.SERVICE_ORDER_STATE_INVALID, '仅已接单可完成');
    return this.prisma.t.serviceOrder.update({ where: { id }, data: { status: 'DONE', doneAt: new Date() } });
  }

  async adminCancel(id: string) {
    const order = await this.mustGet(id);
    if (order.status === 'DONE' || order.status === 'CANCELED') {
      throw new BizException(ErrorCode.SERVICE_ORDER_STATE_INVALID, '该预约已结束');
    }
    return this.prisma.t.serviceOrder.update({ where: { id }, data: { status: 'CANCELED' } });
  }
}
