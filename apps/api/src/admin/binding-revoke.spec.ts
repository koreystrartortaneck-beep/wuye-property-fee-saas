import { ErrorCode } from '@pf/shared';
import { BindingsService } from './bindings.controller';

/**
 * 物业必须能解除一条已生效的绑定。
 *
 * 排查「业主从打开小程序到缴费」的完整流程时发现：管理端只有「列出绑定」和
 * 「审核 PENDING 申请」两个接口 —— **没有任何办法解除一条已经生效的绑定**。
 *
 * 而租客到期、业主卖房、当初绑错房号，这些必然会发生。解不掉的后果是：
 * 那个人一直看得到这户的账单、一直能替这户缴费。
 *
 * 唯一的替代办法是让业主自己在小程序里点「注销账号」——
 * 但那会连他的身份数据一起匿名化、且不可逆，拿它当解绑用是错的。
 */

function makeService(binding: Record<string, unknown> | null, updateCount = 1) {
  /*
   * 参数要显式标出来。jest.fn(async () => ...) 会把 mock.calls 推成 [] 元组，
   * 于是 mock.calls[0][0] 直接是类型错误 —— 而 Jest 报的是「Tests: 0 total」，
   * 那不是「测试通过」，是根本没跑。
   */
  const findUnique = jest.fn(async (_args: unknown) => binding);
  const updateMany = jest.fn(async (_args: { data: Record<string, unknown> }) => ({ count: updateCount }));
  const append = jest.fn(async (_input: { afterSummary: Record<string, unknown> }) => ({}));
  const prisma = { t: { houseBinding: { findUnique, updateMany } } };
  // revoke 路径不触碰 BindingSyncService,传一个只会在误用时爆炸的哨兵即可
  const bindingSync = new Proxy({}, { get: () => { throw new Error('revoke 不应触碰 BindingSyncService'); } });
  return {
    service: new BindingsService(prisma as never, { append } as never, bindingSync as never),
    findUnique,
    updateMany,
    append,
  };
}

const ACTIVE = {
  id: 'b1',
  tenantId: 't1',
  status: 'ACTIVE',
  houseId: 'h1',
  wxUserId: 'u1',
  house: { communityId: 'c1', code: 'PAY-001', displayName: '1栋1单元101' },
};

describe('解除绑定', () => {
  it('已生效的绑定可以解除，并记下原因', async () => {
    const { service, updateMany } = makeService(ACTIVE);
    const r = (await service.revoke('b1', 'admin-1', { reason: '租客已到期' })) as unknown as {
      status: string;
      revokeReason: string;
    };
    expect(r.status).toBe('REJECTED');
    expect(r.revokeReason).toBe('租客已到期');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b1', status: 'ACTIVE' } }),
    );
  });

  it('用条件更新——两人同时操作时不能后写的静默覆盖前写的', async () => {
    /*
     * 和 review 同一个理由：权限变更上「后写覆盖前写」不是排序问题而是越权问题。
     * count 不为 1 说明这条绑定刚被别人处理过，必须报错而不是当作成功。
     */
    const { service } = makeService(ACTIVE, 0);
    await expect(service.revoke('b1', 'admin-1', { reason: 'x' })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION.code,
    });
  });

  it('用 revokedAt 与「申请被驳回」区分开', async () => {
    /*
     * 两者库里都是 REJECTED，但对业主是完全不同的事：
     * 「申请未通过」是你还没进来，「绑定已解除」是你本来在、被请出去了。
     * 对一个原本能看到账单的人说「申请未通过」，他会一头雾水。
     */
    const { service, updateMany } = makeService(ACTIVE);
    await service.revoke('b1', 'admin-1', { reason: '业主已卖房' });
    const data = updateMany.mock.calls[0][0].data;
    expect(data.revokedAt).toBeInstanceOf(Date);
    expect(data.revokeReason).toBe('业主已卖房');
  });

  it('必须写审计——这是一次权限撤销', async () => {
    /*
     * 撤销之后那个人再也看不到这户的账单。注销账号那条路径早就写了审计
     * （ACCOUNT_DELETE_UNBIND），物业主动解绑不能反而没有。
     */
    const { service, append } = makeService(ACTIVE);
    await service.revoke('b1', 'admin-1', { reason: '绑错房号' });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'ADMIN',
        actorId: 'admin-1',
        resourceType: 'HouseBinding',
        reason: '绑错房号',
        afterSummary: expect.objectContaining({ event: 'BINDING_REVOKE' }),
      }),
    );
    // 房号要记下来：查审计的人认得房号，认不得 cuid
    expect(append.mock.calls[0][0].afterSummary.houseCode).toBe('PAY-001');
  });

  it('非 ACTIVE 的绑定不能解除', async () => {
    const { service } = makeService({ ...ACTIVE, status: 'PENDING' });
    await expect(service.revoke('b1', 'admin-1', { reason: 'x' })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION.code,
    });
  });

  it('绑定不存在 → NOT_FOUND', async () => {
    const { service } = makeService(null);
    await expect(service.revoke('nope', 'admin-1', { reason: 'x' })).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND.code,
    });
  });

  it('限定 TENANT_ADMIN——RolesGuard 没标注解就放行所有管理员', () => {
    /*
     * 解除绑定撤销一个人对该户账单的全部访问权，风险等同退款那一类。
     * 而 RolesGuard 的规则是「没标 @Roles 就放行所有已登录管理员」，
     * 一旦为收费员开了 STAFF 账号就立刻变成真实越权。
     */
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'bindings.controller.ts'),
      'utf8',
    ) as string;
    const i = src.indexOf("@Post(':id/revoke')");
    expect(i).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, i - 200), i)).toMatch(/@Roles\('TENANT_ADMIN'\)/);
  });

  it('业主端接口带出 revokedAt/revokeReason，否则前端分不清两种 REJECTED', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'owner', 'owner-houses.controller.ts'),
      'utf8',
    ) as string;
    const i = src.indexOf('async myBindings');
    const body = src.slice(i, src.indexOf('\n  }', i));
    expect(body).toMatch(/revokedAt:/);
    expect(body).toMatch(/revokeReason:/);
  });
});
