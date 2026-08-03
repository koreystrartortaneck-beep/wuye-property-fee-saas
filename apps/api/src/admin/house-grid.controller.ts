import { Controller, Get, Injectable, Query, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { assertCommunityInTenant } from './community-scope';
import { centsToStr, toCents } from '../billing/engine/money';
import { PrismaService } from '../prisma/prisma.service';

/*
 * 楼盘图 —— 物业收费软件的经典视图,也是物业人员的真实心智模型:
 * 哪栋、哪单元、哪层、哪户,颜色即状态(欠费红)。
 * 实测反馈:搜索框适合接电话查户,日常巡查得靠「点格子」。
 *
 * 房号 → 栋/单元/层/户 由解析器从 code 推导(金港城的三种真实形状都覆盖,
 * 见 parseHouseCode 与其 spec)。House 表的 building/unit/room 列多为空
 * (历史导入没填),解析器以 code 为准 —— code 是唯一从第一天就完整的字段。
 */

export interface GridCell {
  id: string;
  /** 格子上显示的短号(户号或车位号) */
  label: string;
  displayName: string;
  floor: number;
  unpaidCount: number;
  unpaidAmount: string | null;
  disabled: boolean;
}

/**
 * 金港城三种真实房号形状(取自导入的 555 套):
 *   A-1-502        → A栋 1单元 5层02户
 *   B-5-1602       → B栋 5单元 16层02户
 *   2-1-1-1102     → 2期1栋 1单元 11层02户
 *   G-001          → 车库(平铺,无层)
 *   2期1号楼001    → 2期1号楼(门市,平铺)
 *   商场M111/商场107门市 → 商场(平铺)
 * 认不出的形状进「其他」组平铺 —— 绝不静默丢一套房。
 */
export function parseHouseCode(type: string, code: string): { building: string; unit: string | null; room: string } {
  if (type === 'PARKING') return { building: '车库', unit: null, room: code.replace(/^G-?/, '') || code };

  let m = /^([A-Z])-(\d+)-(\d+)$/.exec(code);
  if (m) return { building: `${m[1]}栋`, unit: `${m[2]}单元`, room: m[3] };

  m = /^(\d+)-(\d+)-(\d+)-(\d+)$/.exec(code);
  if (m) return { building: `${m[1]}期${m[2]}栋`, unit: `${m[3]}单元`, room: m[4] };

  m = /^(\d+期\d+号楼)(\d+.*)$/.exec(code);
  if (m) return { building: m[1], unit: null, room: m[2] };

  if (/^商场/.test(code)) return { building: '商场', unit: null, room: code.replace(/^商场/, '') };

  // 门市里还有 A-5 / B-6 这类两段短号
  m = /^([A-Z])-(\d+)$/.exec(code);
  if (m) return { building: `门市${m[1]}排`, unit: null, room: m[2] };

  return { building: '其他', unit: null, room: code };
}

/** 户号 → 楼层:1602 → 16 层;502 → 5 层;两位及以下(车位号等)无层 */
export function floorOf(room: string): number {
  const digits = /^(\d+)/.exec(room)?.[1] ?? '';
  if (digits.length <= 2) return 0;
  return Number(digits.slice(0, digits.length - 2));
}

class GridQuery {
  @IsString()
  @IsNotEmpty()
  communityId!: string;
}

@Injectable()
export class HouseGridService {
  constructor(private readonly prisma: PrismaService) {}

  async grid(communityId: string) {
    await assertCommunityInTenant(this.prisma, communityId);
    const houses = await this.prisma.t.house.findMany({
      where: { communityId },
      select: { id: true, code: true, displayName: true, type: true, status: true },
      orderBy: { code: 'asc' },
    });

    /*
     * 欠费按户聚合,一次 groupBy —— 551 套也只是一次查询。
     * 楼盘图的颜色只关心 UNPAID(待缴):草稿业主看不见不算欠,退款中另有页面管。
     */
    const unpaid = await this.prisma.t.bill.groupBy({
      by: ['houseId'],
      where: { communityId, status: 'UNPAID' },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const unpaidByHouse = new Map(unpaid.map((u) => [u.houseId, u]));

    // building → unit → floor → cells
    const buildings = new Map<string, Map<string, Map<number, GridCell[]>>>();
    for (const h of houses) {
      const parsed = parseHouseCode(h.type, h.code);
      const floor = floorOf(parsed.room);
      const u = unpaidByHouse.get(h.id);
      const cell: GridCell = {
        id: h.id,
        label: parsed.room,
        displayName: h.displayName,
        floor,
        unpaidCount: u?._count._all ?? 0,
        unpaidAmount: u?._sum.amount ? centsToStr(toCents(u._sum.amount.toString())) : null,
        disabled: h.status !== 'ACTIVE',
      };
      const unitKey = parsed.unit ?? '';
      if (!buildings.has(parsed.building)) buildings.set(parsed.building, new Map());
      const units = buildings.get(parsed.building)!;
      if (!units.has(unitKey)) units.set(unitKey, new Map());
      const floors = units.get(unitKey)!;
      if (!floors.has(floor)) floors.set(floor, []);
      floors.get(floor)!.push(cell);
    }

    /*
     * 排序规则贴楼盘图习惯:
     * 楼栋按名称;层从高到低(顶层在上,和站在楼前看一致);层内按户号。
     * 无层的组(车库/商场)平铺,按号排。
     */
    const result = [...buildings.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'zh'))
      .map(([building, units]) => ({
        building,
        unpaidHouses: [...units.values()].flatMap((f) => [...f.values()].flat()).filter((c) => c.unpaidCount > 0).length,
        houses: [...units.values()].reduce((s, f) => s + [...f.values()].flat().length, 0),
        units: [...units.entries()]
          .sort((a, b) => a[0].localeCompare(b[0], 'zh'))
          .map(([unit, floors]) => ({
            unit: unit || null,
            floors: [...floors.entries()]
              .sort((a, b) => b[0] - a[0])
              .map(([floor, cells]) => ({
                floor,
                cells: cells.sort((a, b) => a.label.localeCompare(b.label, 'zh', { numeric: true })),
              })),
          })),
      }));

    return { buildings: result };
  }
}

@Controller('admin/houses-grid')
@UseGuards(AdminGuard, RolesGuard)
export class HouseGridController {
  constructor(private readonly service: HouseGridService) {}

  @Get()
  grid(@Query() q: GridQuery) {
    return this.service.grid(q.communityId);
  }
}
