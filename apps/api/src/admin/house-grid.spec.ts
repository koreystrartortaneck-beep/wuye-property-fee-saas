import { Prisma } from '@prisma/client';
import { HouseGridController, HouseGridService, floorOf, parseHouseCode } from './house-grid.controller';

/**
 * 楼盘图。核心是房号解析:金港城 555 套的三种真实形状必须逐一认对,
 * 认不出的进「其他」组 —— **绝不静默丢一套房**(丢了就是「这户在系统里不存在」)。
 */

describe('房号解析(全部取自真实数据形状)', () => {
  it.each([
    ['RESIDENCE', 'A-1-502', 'A栋', '1单元', '502'],
    ['RESIDENCE', 'B-5-1602', 'B栋', '5单元', '1602'],
    ['RESIDENCE', '2-1-1-1102', '2期1栋', '1单元', '1102'],
    ['RESIDENCE', '2-2-3-302', '2期2栋', '3单元', '302'],
    ['PARKING', 'G-001', '车库', null, '001'],
    ['SHOP', '2期1号楼001', '2期1号楼', null, '001'],
    ['SHOP', '商场M111', '商场', null, 'M111'],
    ['SHOP', '商场107门市', '商场', null, '107门市'],
    ['SHOP', 'A-5', '门市A排', null, '5'],
  ])('%s %s → %s %s %s', (type, code, building, unit, room) => {
    expect(parseHouseCode(type, code)).toEqual({ building, unit, room });
  });

  it('认不出的形状进「其他」,不丢', () => {
    expect(parseHouseCode('RESIDENCE', '安宽')).toEqual({ building: '其他', unit: null, room: '安宽' });
  });

  it('楼层推导:末两位是户号,前面是层;两位及以下无层', () => {
    expect(floorOf('1602')).toBe(16);
    expect(floorOf('502')).toBe(5);
    expect(floorOf('001')).toBe(0);
    expect(floorOf('5')).toBe(0);
    expect(floorOf('M111')).toBe(0); // 非数字开头无层
  });
});

describe('网格聚合', () => {
  function makeService(houses: unknown[], unpaid: Array<{ houseId: string; sum: string; count: number }>) {
    const prisma = {
      t: {
        house: { findMany: jest.fn(async () => houses) },
        bill: {
          groupBy: jest.fn(async () =>
            unpaid.map((u) => ({ houseId: u.houseId, _sum: { amount: new Prisma.Decimal(u.sum) }, _count: { _all: u.count } })),
          ),
        },
        community: { findFirst: jest.fn(async () => ({ id: 'c1' })) },
      },
    };
    return new HouseGridService(prisma as never);
  }
  const H = (id: string, code: string, type = 'RESIDENCE', status = 'ACTIVE') => ({
    id, code, displayName: code, type, status,
  });

  it('栋→单元→层(高层在上)→户;欠费金额与笔数落在格子上', async () => {
    const svc = makeService(
      [H('h1', 'B-5-1602'), H('h2', 'B-5-502'), H('h3', 'B-5-501'), H('h4', 'A-1-502')],
      [{ houseId: 'h2', sum: '1522.00', count: 1 }],
    );
    const { buildings } = await svc.grid('c1');
    expect(buildings.map((b) => b.building)).toEqual(['A栋', 'B栋']);
    const b = buildings[1];
    expect(b.houses).toBe(3);
    expect(b.unpaidHouses).toBe(1);
    const floors = b.units[0].floors;
    expect(floors.map((f) => f.floor)).toEqual([16, 5]); // 顶层在上
    const f5 = floors[1];
    expect(f5.cells.map((c) => c.label)).toEqual(['501', '502']);
    expect(f5.cells[1]).toMatchObject({ unpaidCount: 1, unpaidAmount: '1522.00' });
    expect(f5.cells[0]).toMatchObject({ unpaidCount: 0, unpaidAmount: null });
  });

  it('每一套房都必须出现在网格里——总数守恒', async () => {
    const codes = ['A-1-502', 'B-5-1602', '2-1-1-1102', 'G-001', '商场M111', '2期1号楼001', '安宽'];
    const svc = makeService(codes.map((c, i) => H(`h${i}`, c, c === 'G-001' ? 'PARKING' : 'RESIDENCE')), []);
    const { buildings } = await svc.grid('c1');
    const total = buildings.reduce((s, b) => s + b.houses, 0);
    expect(total).toBe(codes.length);
  });

  it('停用的房是灰格,不是消失', async () => {
    const svc = makeService([H('h1', 'A-1-502', 'RESIDENCE', 'DISABLED')], []);
    const { buildings } = await svc.grid('c1');
    expect(buildings[0].units[0].floors[0].cells[0].disabled).toBe(true);
  });
});

describe('parse 预览端点(新建房屋页「会归到哪」)', () => {
  /*
   * 2026-08-05 用户建「003-013」进了「其他」组,在楼盘图上找不到,
   * 以为「新建房屋没有绑定到楼盘」。规则只在 parseHouseCode 一处,
   * 小程序填号时现问 —— 这个端点是它问的地方。
   */
  const c = new HouseGridController(null as never);

  it('认得出的房号给出准确归位', () => {
    expect(c.parse({ type: 'RESIDENCE', code: '2-1-1-1102' } as never)).toEqual({
      building: '2期1栋',
      unit: '1单元',
      room: '1102',
      floor: 11,
      recognized: true,
    });
  });

  it('认不出的形状如实说 recognized:false,而不是编一个位置', () => {
    const r = c.parse({ type: 'RESIDENCE', code: '003-013' } as never);
    expect(r).toMatchObject({ building: '其他', recognized: false });
  });
});
