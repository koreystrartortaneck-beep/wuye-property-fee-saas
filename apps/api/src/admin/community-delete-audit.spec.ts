import { CommunitiesService } from './communities.controller';

/**
 * 2026-08-02：造体验数据前先做了一次「造 3 户 → 立刻清理」的演练，
 * 结果清理卡在最后一步 —— **房屋全删光了，小区还是删不掉。**
 *
 * 原因是一个自锁：
 *
 *   · AuditLog 有一条指向 Community 的外键（..._restrict_fkey）
 *   · 删小区的前置步骤是「先删光它下面的房屋」
 *   · 而每删一套房屋都会写一条带 communityId 的审计
 *   · 于是删完房屋的那一刻，小区反而被刚写下的审计钉死了
 *
 * 更糟的是它的表现：挂载清点全部为 0，界面显示可以删，数据库在最后一步拒绝，
 * 返回「关联的数据不存在或已被删除，请刷新后重试」—— 正好说反。
 * 物业照着提示去刷新、再删，再看到同一句话。
 *
 * 库里那个「【勿用】审计测试遗留-待删」删不掉，就是这么来的。
 * 而它不是新问题：任何一次对小区的后台操作都会写审计，
 * 也就是说**只要这个小区被用过，它就永远删不掉**。
 */

function makeService(counts: Record<string, number> = {}) {
  const calls: string[] = [];
  let detachArgs: unknown = null;
  const audits: Record<string, unknown>[] = [];

  const tx = {
    auditLog: {
      updateMany: (args: unknown) => {
        detachArgs = args;
        calls.push('detach');
        return Promise.resolve({ count: 12 });
      },
    },
    community: {
      delete: () => {
        calls.push('delete');
        return Promise.resolve({});
      },
    },
  };

  const model = (name: string) => ({ count: () => Promise.resolve(counts[name] ?? 0) });
  const prisma = {
    raw: { $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) },
    t: new Proxy(
      {
        community: {
          findFirst: () => Promise.resolve({ id: 'c1', name: '云顶花园', tenantId: 't1' }),
        },
      } as Record<string, unknown>,
      {
        get: (target, prop: string) => target[prop] ?? model(prop),
      },
    ),
  };
  const audit = { append: (e: Record<string, unknown>) => { audits.push(e); return Promise.resolve(); } };
  return { service: new CommunitiesService(prisma as never, audit as never), calls, audits, detach: () => detachArgs };
}

describe('删除小区', () => {
  it('先把审计行摘钩，再删小区——顺序反了照样删不掉', async () => {
    const { service, calls } = makeService();
    await service.remove('c1', 'admin1');
    expect(calls).toEqual(['detach', 'delete']);
  });

  it('摘钩是置空 communityId，不是删审计行', async () => {
    /*
     * 这条是红线。审计是历史 ——
     * 删除一个小区不该抹掉「它存在期间发生过什么」。
     * tenantId、动作、资源、摘要必须原样留着，只是不再挂在一个已消失的小区上。
     */
    const { service, detach } = makeService();
    await service.remove('c1', 'admin1');
    expect(detach()).toEqual({
      where: { tenantId: 't1', communityId: 'c1' },
      data: { communityId: null },
    });
  });

  it('摘钩与删除在同一个事务里', async () => {
    /*
     * 分开做的话，摘钩成功而删除失败会留下一堆再也关联不回去的审计行 ——
     * 小区还在，它的历史却断了。
     */
    let inTx = false;
    const { service } = makeService();
    const prismaRaw = (service as unknown as { prisma: { raw: { $transaction: unknown } } }).prisma.raw;
    const orig = prismaRaw.$transaction as (fn: (t: unknown) => Promise<unknown>) => Promise<unknown>;
    prismaRaw.$transaction = (fn: (t: unknown) => Promise<unknown>) => {
      inTx = true;
      return orig(fn);
    };
    await service.remove('c1', 'admin1');
    expect(inTx).toBe(true);
  });

  it('还有房屋时不摘钩也不删', async () => {
    const { service, calls } = makeService({ house: 3 });
    await expect(service.remove('c1', 'admin1')).rejects.toThrow(/房屋 3 条/);
    expect(calls).toEqual([]);
  });

  it('删小区要留痕，并记下摘了多少条审计', async () => {
    /*
     * 摘钩之后那些历史审计行不再指向任何小区，
     * 「这个小区去哪了」就只剩这一条记录能回答。原来它压根没有审计。
     */
    const { service, audits } = makeService();
    await service.remove('c1', 'admin7');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'DELETE',
      resourceType: 'Community',
      resourceId: 'c1',
      actorId: 'admin7',
      communityId: null, // 小区都没了，不能再往这条审计上挂它
    });
    expect(JSON.stringify(audits[0].beforeSummary)).toContain('云顶花园');
    expect(JSON.stringify(audits[0].afterSummary)).toContain('12');
  });
});
