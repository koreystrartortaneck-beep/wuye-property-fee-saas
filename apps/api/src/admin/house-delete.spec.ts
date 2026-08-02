import { HousesService } from './houses.controller';
import { BizException } from '../common/biz.exception';

/**
 * 2026-08-02：要在生产上造 200 户测试数据之前，先发现一件事 ——
 * **房屋删不掉。**
 *
 * 后台只有导入（POST /admin/houses/import）、列表、修改（PATCH）三个口子，
 * 修改里能做的最狠的事是把 status 改成 DISABLED。于是：
 *
 *   · 导错一批（房号规则搞错、导到了错的小区、造的测试数据）之后没有退路
 *   · 停用不是删除。停用的语义是「这套房还在，只是暂时不收费」，
 *     而导错的那行根本不该存在 —— 它还会和正确的房号撞 (communityId, code) 唯一键
 *   · 更死的一环：删小区要求下面没有房屋。房屋删不掉 → 那个小区也永远删不掉。
 *     这正是库里那个「【勿用】审计测试遗留-待删」至今还在的原因
 *
 * 补删除时的两条红线：不许级联，必须留痕。
 */

type Counts = Record<string, number>;

function makeService(house: unknown, counts: Counts = {}) {
  const deleted: unknown[] = [];
  const audits: Record<string, unknown>[] = [];
  const model = (name: string) => ({
    count: ({ where }: { where: { houseId: string } }) => {
      expect(where.houseId).toBe('h1'); // 每个挂载检查都必须按房屋过滤
      return Promise.resolve(counts[name] ?? 0);
    },
  });
  const prisma = {
    t: {
      house: {
        findFirst: () => Promise.resolve(house),
        delete: (args: unknown) => {
          deleted.push(args);
          return Promise.resolve({});
        },
      },
      bill: model('bill'),
      houseBinding: model('houseBinding'),
      ticket: model('ticket'),
      visitorPass: model('visitorPass'),
      serviceOrder: model('serviceOrder'),
    },
  };
  const audit = { append: (e: Record<string, unknown>) => { audits.push(e); return Promise.resolve(); } };
  return { service: new HousesService(prisma as never, audit as never), deleted, audits };
}

const HOUSE = {
  id: 'h1',
  code: 'JGC-1-101',
  displayName: '1栋1单元101',
  communityId: 'c1',
  tenantId: 't1',
};

describe('删除房屋', () => {
  it('干净的房屋可以删掉', async () => {
    const { service, deleted } = makeService(HOUSE);
    const res = await service.remove('h1', 'admin1');
    expect(res).toEqual({ deleted: true, code: 'JGC-1-101' });
    expect(deleted).toHaveLength(1);
  });

  it('有账单就不许删——删了账单会指向一套不存在的房', async () => {
    const { service, deleted } = makeService(HOUSE, { bill: 3 });
    await expect(service.remove('h1', 'admin1')).rejects.toThrow(BizException);
    expect(deleted).toHaveLength(0);
  });

  it('有业主绑着就不许删——那个人的账单会凭空消失', async () => {
    const { service } = makeService(HOUSE, { houseBinding: 1 });
    await expect(service.remove('h1', 'admin1')).rejects.toThrow(BizException);
  });

  it('提示要说清挂着什么、各多少条', async () => {
    /*
     * 只说「不能删除」，物业得自己一个一个去翻是哪里挡着。
     * 删小区那条早就把挂载明细写出来了，这里不能比它差。
     */
    const { service } = makeService(HOUSE, { bill: 2, ticket: 1 });
    await expect(service.remove('h1', 'admin1')).rejects.toThrow(/账单 2 条/);
    await expect(service.remove('h1', 'admin1')).rejects.toThrow(/工单 1 条/);
    // 还要给出替代动作，否则物业只知道做不了、不知道能做什么
    await expect(service.remove('h1', 'admin1')).rejects.toThrow(/停用/);
  });

  it('绝不级联删除', async () => {
    /*
     * 这条是红线。一个「删除房屋」的动作顺手把账单和缴费记录一起删掉，
     * 是不可接受的 —— 钱的凭证不能被一次房产资料整理抹掉。
     */
    const { service, deleted } = makeService(HOUSE, { bill: 1, ticket: 1, visitorPass: 1 });
    await expect(service.remove('h1', 'admin1')).rejects.toThrow();
    expect(deleted).toHaveLength(0);
  });

  it('不属于本公司的房屋按「不存在」处理', async () => {
    // prisma.t 已按租户过滤，findFirst 查不到就是越权或不存在，不区分——不给探测存在性的机会
    const { service } = makeService(null);
    await expect(service.remove('h1', 'admin1')).rejects.toThrow(BizException);
  });

  it('删除必须留痕，且动作是 DELETE 不是 UPDATE', async () => {
    /*
     * 房屋是计费的根。删掉之后再想追「这户去哪了」，除了审计没有任何地方查得到。
     * 而把删除记成 UPDATE，等于在这个唯一可信的地方写假话。
     */
    const { service, audits } = makeService(HOUSE);
    await service.remove('h1', 'admin9');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'DELETE',
      resourceType: 'House',
      resourceId: 'h1',
      actorType: 'ADMIN',
      actorId: 'admin9',
      tenantId: 't1',
      communityId: 'c1',
    });
    // 房号必须落进审计：查审计的人认得房号，认不得 cuid
    expect(JSON.stringify(audits[0].beforeSummary)).toContain('JGC-1-101');
  });

  it('拒绝时不写审计——没发生的事不该留痕', async () => {
    const { service, audits } = makeService(HOUSE, { bill: 1 });
    await expect(service.remove('h1', 'admin1')).rejects.toThrow();
    expect(audits).toHaveLength(0);
  });
});
