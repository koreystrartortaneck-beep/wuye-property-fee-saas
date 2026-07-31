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
    /*
     * 小区范围必须在**下单时**校验，不能只靠列表接口过滤。
     *
     * availableItems 按 (communityId = 本小区 或 null) 过滤，但下单原本只比 tenantId ——
     * 业主把另一个小区的 serviceItemId 传进来就能预约不属于自己小区的服务。
     * 服务价格按小区定，也可能是某小区的专属福利，所以这是实打实的越权，
     * 不只是「看到了不该看的」。
     *
     * 券的消费路径（consumeCouponInTx）本来就做了同一件事 —— 做对了一处、漏了这处。
     */
    const scopeOk = item && (item.communityId === null || item.communityId === house!.communityId);
    if (!item || !item.enabled || item.tenantId !== house!.tenantId || !scopeOk) {
      throw new BizException(ErrorCode.SERVICE_UNAVAILABLE);
    }
    /*
     * 期望日期按北京时间的「日」比较，且不接受过去的日期。
     *
     * DTO 只校验了 YYYY-MM-DD 的形状。传 2020-01-01 会建出一个「期望上门日期已过」
     * 的订单：物业的待接单列表里排在最前面（按 expectDate 排序），
     * 接了也没法上门，只能手工作废。
     *
     * 用 +8 偏移取当天而不是 Intl：与小程序侧的 fmtDate 口径一致。
     */
    const expectDate = new Date(`${dto.expectDate}T00:00:00+08:00`);
    if (Number.isNaN(expectDate.getTime())) throw new BizException(ErrorCode.VALIDATION, 'expectDate 非法');
    const todayCn = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    if (dto.expectDate < todayCn) {
      throw new BizException(ErrorCode.VALIDATION, '期望上门日期不能早于今天');
    }

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
