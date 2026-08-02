import { OwnerHousesService } from './owner-houses.controller';

/**
 * 2026-08-02 业主问：「如果有一两百户、好几个小区之后，这个怎么提交绑定？」
 *
 * 查下来这不是界面不好看的问题，是**功能到不了那么多户**：
 *
 *   · listHouses 写死 take: 100，按 code 升序 —— 一个 213 户的小区，
 *     第 101 户往后的业主在列表里根本不存在。
 *   · 而界面上没有任何异样：没有「还有更多」，没有分页，没有提示。
 *     业主翻完能翻的，得出的结论只会是「物业没登记我家」，
 *     然后打电话过来，而物业在后台看得见这套房 —— 双方都说不清。
 *   · searchCommunities 同理（take: 50）。
 *
 * 截断本身不可避免：不能把 213 条一次推给手机。
 * 可避免的是**不说**。所以两个查询都必须回传 total，界面才说得出
 * 「共 213 套，只显示了前 20 套，请输入房号缩小范围」。
 */

type FindManyArgs = { where?: unknown; take?: number; orderBy?: unknown };

function makeService(houseRows: unknown[], houseTotal: number, communityRows: unknown[] = [], communityTotal = 0) {
  const calls: { houses: FindManyArgs[]; communities: FindManyArgs[]; counts: unknown[] } = {
    houses: [],
    communities: [],
    counts: [],
  };
  const prisma = {
    raw: {
      house: {
        findMany: (args: FindManyArgs) => {
          calls.houses.push(args);
          return Promise.resolve(houseRows.slice(0, args.take));
        },
        count: (args: { where: unknown }) => {
          calls.counts.push(args.where);
          return Promise.resolve(houseTotal);
        },
      },
      community: {
        findMany: (args: FindManyArgs) => {
          calls.communities.push(args);
          return Promise.resolve(communityRows.slice(0, args.take));
        },
        count: () => Promise.resolve(communityTotal),
      },
    },
  };
  return { service: new OwnerHousesService(prisma as never), calls };
}

const houses = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `h${i}`,
    code: `JGC-1-${100 + i}`,
    displayName: `1栋${100 + i}`,
    type: 'RESIDENCE',
    building: '1',
  }));

describe('房号选择必须扛得住一两百户', () => {
  it('总数如实回传，界面才说得出「还有多少没显示」', async () => {
    const { service } = makeService(houses(213), 213);
    const res = await service.listHouses('c1');
    expect(res.total).toBe(213);
    expect(res.items.length).toBeLessThan(213);
    /*
     * 这条断言的重点在 total 上。
     * 只回 items 时，「刚好 20 条」和「有 213 条只给了 20 条」在业主端完全同形，
     * 而这两种情况该显示的文案是相反的。
     */
  });

  it('一页不许铺太多——20 条上下，再多就滚不完了', async () => {
    const { service, calls } = makeService(houses(213), 213);
    await service.listHouses('c1');
    const take = calls.houses[0].take!;
    expect(take).toBeGreaterThanOrEqual(10);
    expect(take).toBeLessThanOrEqual(30);
  });

  it('count 与 findMany 用同一个 where —— 否则总数是另一个问题的答案', async () => {
    /*
     * 很容易写成 count({ where: { communityId } }) 而 findMany 还带着 keyword：
     * 搜「101」得到 1 条，却提示「共 213 套，只显示了前 1 套」，
     * 业主会以为自己搜错了，继续翻。
     */
    const { service, calls } = makeService(houses(3), 3);
    await service.listHouses('c1', undefined, '101');
    expect(calls.counts[0]).toEqual(calls.houses[0].where);
  });

  it('房号关键词同时匹配 code 与 displayName', async () => {
    /*
     * 业主记得的可能是「1-101」（物业的编号），也可能是「1栋101」（门牌）。
     * 只匹配一种，另一种人就搜不到，而他不会想到换个写法。
     */
    const { service, calls } = makeService(houses(1), 1);
    await service.listHouses('c1', undefined, '101');
    expect(JSON.stringify(calls.houses[0].where)).toContain('code');
    expect(JSON.stringify(calls.houses[0].where)).toContain('displayName');
  });

  it('不传关键词时也能用——小区户数少的时候不该逼人先搜索', async () => {
    const { service } = makeService(houses(5), 5);
    const res = await service.listHouses('c1');
    expect(res.items).toHaveLength(5);
    expect(res.total).toBe(5);
  });

  it('小区列表同样回传总数——物业不止管一个小区', async () => {
    const communities = Array.from({ length: 60 }, (_, i) => ({
      id: `c${i}`,
      name: `小区${i}`,
      address: '',
      tenant: { name: '港城物业' },
    }));
    const { service } = makeService([], 0, communities, 60);
    const res = await service.searchCommunities('小区');
    expect(res.total).toBe(60);
    expect(res.items.length).toBeLessThan(60);
    expect(res.items[0]).toHaveProperty('tenantName', '港城物业');
  });
});
