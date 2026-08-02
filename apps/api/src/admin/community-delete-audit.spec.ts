import { CommunitiesService } from './communities.controller';

/**
 * 「删光房屋之后小区还是删不掉」—— 这条我先做错了一次，记在这里。
 *
 * 现象：造 200 户体验数据之前先演练「造 3 户 → 立刻清理」，
 * 房屋全删光了，删小区仍然失败。
 *
 * 我的第一版判断是「自锁，应该绕开」：
 *   · AuditLog 有一条指向 Community 的外键
 *   · 删小区的前置步骤是先删房屋，而每删一套房屋都会写一条带 communityId 的审计
 *   · 于是删完房屋的那一刻，小区反而被刚写下的审计钉死
 * 于是我在删小区时先把这些审计行的 communityId 摘成 null。
 *
 * **这是错的。** 上线后删小区直接 50000 —— AuditLog 上有一个
 * BEFORE UPDATE 触发器，无条件 SIGNAL 45000
 * 'AuditLog is append-only: UPDATE is forbidden'。
 *
 * 而那个触发器不是障碍，是设计。同一个迁移里还写着
 * "Parent keys are immutable once referenced by an audit row"：
 * 审计不可改、不可删，被审计引用的父记录也不可动。
 * 换句话说 —— **一个产生过历史的小区，本来就不该能被删掉**，
 * 这是拿「可删除性」换「审计完整性」，换得对。
 *
 * 我不但绕错了方向，还把结果变坏了：原来是「拒绝并说明原因」，
 * 被我改成了「服务器内部错误」。
 *
 * 正确的做法是让预检如实说出这件事，并给出真正可行的下一步（停用）。
 */

function makeService(counts: Record<string, number> = {}) {
  const deleted: unknown[] = [];
  const audits: Record<string, unknown>[] = [];
  const model = (name: string) => ({ count: () => Promise.resolve(counts[name] ?? 0) });
  const prisma = {
    t: new Proxy(
      {
        community: {
          findFirst: () => Promise.resolve({ id: 'c1', name: '云顶花园', tenantId: 't1' }),
          delete: (args: unknown) => {
            deleted.push(args);
            return Promise.resolve({});
          },
        },
      } as Record<string, unknown>,
      { get: (target, prop: string) => target[prop] ?? model(prop) },
    ),
  };
  const audit = { append: (e: Record<string, unknown>) => { audits.push(e); return Promise.resolve(); } };
  return { service: new CommunitiesService(prisma as never, audit as never), deleted, audits };
}

describe('删除小区', () => {
  it('从未产生过审计的小区可以删', async () => {
    const { service, deleted } = makeService();
    const res = await service.remove('c1', 'admin1');
    expect(res).toMatchObject({ deleted: true, name: '云顶花园' });
    expect(deleted).toHaveLength(1);
  });

  it('有审计记录就不许删——而且预检必须先拦住', async () => {
    /*
     * 关键在「先」。原先 auditLog 不在挂载清单里：
     * 预检全绿 → 界面显示可以删 → 数据库在最后一步拒绝。
     * 用户看到的是一个本可以提前说清的失败。
     */
    const { service, deleted } = makeService({ auditLog: 7 });
    await expect(service.remove('c1', 'admin1')).rejects.toThrow(/审计记录 7 条/);
    expect(deleted).toHaveLength(0);
  });

  it('审计那条要说清「永远删不掉」，并给出真正可行的下一步', async () => {
    /*
     * 其余几项（房屋、账单…）物业能自己去清，说「请先清理」是对的。
     * 而审计**按设计永远清不掉** —— 对它说同一句话，
     * 等于让人去做一件做不到的事，他会一直试。
     */
    const { service } = makeService({ auditLog: 7 });
    await expect(service.remove('c1', 'admin1')).rejects.toThrow(/不可删除/);
    await expect(service.remove('c1', 'admin1')).rejects.toThrow(/停用/);
  });

  it('不含审计时用原来的说法——那些数据是真的可以清的', async () => {
    const { service } = makeService({ house: 3 });
    await expect(service.remove('c1', 'admin1')).rejects.toThrow(/房屋 3 条/);
    await expect(service.remove('c1', 'admin1')).rejects.toThrow(/请先转移或清理/);
  });

  it('绝不尝试修改或删除审计行', async () => {
    /*
     * 这条是这次的教训本身。
     * 任何对 AuditLog 的 UPDATE/DELETE 都会被数据库触发器打回，
     * 而在代码里试一下的代价是：把一个清晰的业务拒绝变成 50000。
     */
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'communities.controller.ts'),
      'utf8',
    ) as string;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/auditLog\.(update|updateMany|delete|deleteMany)/);
  });

  it('删小区要留痕', async () => {
    const { service, audits } = makeService();
    await service.remove('c1', 'admin7');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'DELETE',
      resourceType: 'Community',
      resourceId: 'c1',
      actorId: 'admin7',
      // 小区都没了，不能再往这条审计上挂它——挂了它自己就会变成下一个钉子
      communityId: null,
    });
    expect(JSON.stringify(audits[0].beforeSummary)).toContain('云顶花园');
  });
});
