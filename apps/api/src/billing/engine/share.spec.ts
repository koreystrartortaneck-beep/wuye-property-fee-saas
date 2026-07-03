import { allocateShare } from './share';

describe('allocateShare：公摊分摊（总额守恒）', () => {
  it('BY_AREA：100.01 元按面积 50/30/20 分摊，合计恰好 10001 分', () => {
    const { alloc, skipped } = allocateShare(
      10001,
      [
        { id: 'a', area: '50' },
        { id: 'b', area: '30' },
        { id: 'c', area: '20' },
      ],
      'AREA',
    );
    expect(skipped).toHaveLength(0);
    const sum = [...alloc.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBe(10001);
    // 比例大致正确（±1 分）
    expect(Math.abs(alloc.get('a')! - 5001)).toBeLessThanOrEqual(1);
    expect(Math.abs(alloc.get('b')! - 3000)).toBeLessThanOrEqual(1);
    expect(Math.abs(alloc.get('c')! - 2000)).toBeLessThanOrEqual(1);
  });

  it('BY_AREA：无面积的房进 skipped，不参与分摊', () => {
    const { alloc, skipped } = allocateShare(
      9000,
      [
        { id: 'a', area: '60' },
        { id: 'b', area: null },
        { id: 'c', area: '30' },
      ],
      'AREA',
    );
    expect(skipped).toEqual(['b']);
    expect(alloc.get('a')).toBe(6000);
    expect(alloc.get('c')).toBe(3000);
  });

  it('BY_HOUSE：100 元 3 户 → 3334/3333/3333', () => {
    const { alloc } = allocateShare(
      10000,
      [
        { id: 'a', area: null },
        { id: 'b', area: null },
        { id: 'c', area: null },
      ],
      'HOUSE',
    );
    const values = [...alloc.values()].sort((x, y) => y - x);
    expect(values).toEqual([3334, 3333, 3333]);
    expect(values.reduce((s, v) => s + v, 0)).toBe(10000);
  });

  it('空房屋列表 → 空分配', () => {
    const { alloc, skipped } = allocateShare(10000, [], 'HOUSE');
    expect(alloc.size).toBe(0);
    expect(skipped).toHaveLength(0);
  });

  it('BY_AREA 全部无面积 → 全 skipped', () => {
    const { alloc, skipped } = allocateShare(10000, [{ id: 'a', area: null }], 'AREA');
    expect(alloc.size).toBe(0);
    expect(skipped).toEqual(['a']);
  });
});
