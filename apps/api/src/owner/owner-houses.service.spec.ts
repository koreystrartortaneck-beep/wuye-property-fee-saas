import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { OwnerHousesService } from './owner-houses.controller';

/**
 * assertOwnerHouse 是业主端所有"按房屋"接口的统一入口（生活服务/优惠券/工单/账单等）。
 * 缺 houseId 必须显式 400：否则 Prisma 复合唯一键收到 undefined 会抛出，
 * 被兜底成 500「服务器内部错误」，用户看到的是系统故障而非"参数缺失"。
 */
describe('OwnerHousesService.assertOwnerHouse 缺参防护', () => {
  function makeService(binding: unknown) {
    const prisma = {
      raw: { houseBinding: { findUnique: jest.fn().mockResolvedValue(binding) } },
    };
    return { service: new OwnerHousesService(prisma as never), prisma };
  }

  it.each([undefined, null, ''])('houseId 为 %p 时抛参数错误，且不查库（避免 Prisma 抛出→500）', async (bad) => {
    const { service, prisma } = makeService(null);
    await expect(service.assertOwnerHouse('owner-1', bad as never)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION.code,
    });
    expect(prisma.raw.houseBinding.findUnique).not.toHaveBeenCalled();
  });

  it('houseId 合法但无有效绑定时仍抛未绑定', async () => {
    const { service } = makeService(null);
    await expect(service.assertOwnerHouse('owner-1', 'house-1')).rejects.toBeInstanceOf(BizException);
  });

  /** 一条正常的绑定：ACTIVE，且所属物业公司也是 ACTIVE */
  const OK_BINDING = {
    status: 'ACTIVE',
    house: { community: { tenant: { status: 'ACTIVE' } } },
  };

  it('houseId 合法且绑定 ACTIVE 时通过', async () => {
    const { service, prisma } = makeService(OK_BINDING);
    await expect(service.assertOwnerHouse('owner-1', 'house-1')).resolves.toBeUndefined();
    expect(prisma.raw.houseBinding.findUnique).toHaveBeenCalledWith({
      where: { wxUserId_houseId: { wxUserId: 'owner-1', houseId: 'house-1' } },
      include: { house: { select: { community: { select: { tenant: { select: { status: true } } } } } } },
    });
  });
});

/**
 * 物业公司被停用后，它的业主必须立刻失去访问权。
 *
 * 2026-08-02 实测发现的：系统里有一个 status=DISABLED 的租户
 * （早期联调留下的），而它的业主端**完全不受影响** ——
 * 首页照常显示那家公司的房屋和待缴金额、点「立即缴纳」照样能付，
 * 钱照样进那家公司的商户号。**停用等于没停。**
 *
 * 发现过程本身也值得记：业主说「解绑了怎么还显示着房屋」，
 * 我用租户管理员账号查了三遍都是 0 条 ACTIVE 绑定 ——
 * 因为 /admin/bindings 是按租户过滤的，而那条绑定在另一个（停用的）租户里。
 * 两个租户的小区都叫「金港城」、房屋都叫「1栋1单元101」，
 * 界面上完全看不出是两套房。
 *
 * 同一个判断 searchCommunities 里其实早就有（tenant: { status: 'ACTIVE' }）——
 * 有人想到过「不能申请绑定到停用公司」，漏了「已经绑着的怎么办」。
 */
describe('停用的物业公司必须失去业主端访问权', () => {
  function makeService(binding: unknown) {
    const findUnique = jest.fn().mockResolvedValue(binding);
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { raw: { houseBinding: { findUnique, findMany } } };
    return { service: new OwnerHousesService(prisma as never), findUnique, findMany };
  }

  it('绑定有效但物业公司已停用 → 拒绝', async () => {
    const { service } = makeService({
      status: 'ACTIVE',
      house: { community: { tenant: { status: 'DISABLED' } } },
    });
    await expect(service.assertOwnerHouse('owner-1', 'house-1')).rejects.toMatchObject({
      code: ErrorCode.TENANT_DISABLED.code,
    });
  });

  it('用专门的错误码，不复用「未绑定该房屋」', async () => {
    /*
     * 复用 41001 会拼出「未绑定该房屋：该物业公司已停用」这种自相矛盾的话
     * （BizException 的组合方式是 `${定义}：${补充}`），
     * 而且会把业主引去重新绑定 —— 但停用公司的小区根本搜不到，他只会白试。
     */
    const { service } = makeService({
      status: 'ACTIVE',
      house: { community: { tenant: { status: 'DISABLED' } } },
    });
    await expect(service.assertOwnerHouse('owner-1', 'house-1')).rejects.toMatchObject({
      code: ErrorCode.TENANT_DISABLED.code,
      message: expect.stringContaining('已停用'),
    });
    expect(ErrorCode.TENANT_DISABLED.code).not.toBe(ErrorCode.NO_BINDING.code);
  });

  it('房屋列表也要排除停用公司——否则先给希望再拒绝', async () => {
    /*
     * 只在 assertOwnerHouse 拦是不够的：首页会照常显示那家公司的房屋和待缴金额，
     * 业主点「立即缴纳」时才被挡下。先给希望再拒绝，比一开始就不显示更糟。
     */
    const { service, findMany } = makeService(null);
    await service.myHouses('owner-1');
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      status: 'ACTIVE',
      house: { community: { tenant: { status: 'ACTIVE' } } },
    });
  });

  it('查询要经 house → community → tenant，因为 HouseBinding 没有到 Tenant 的关系', () => {
    /*
     * HouseBinding 只有 tenantId 标量。写成 tenant: { status } 会直接类型报错，
     * 但更危险的是有人改成 tenantId 比较 —— 那只能比对 id，比不了状态。
     */
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'owner-houses.controller.ts'),
      'utf8',
    ) as string;
    const hits = src.match(/community: \{ tenant: \{ status: 'ACTIVE' \} \}/g) || [];
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(src).toMatch(/tenant: \{ select: \{ status: true \} \}/);
  });
});
