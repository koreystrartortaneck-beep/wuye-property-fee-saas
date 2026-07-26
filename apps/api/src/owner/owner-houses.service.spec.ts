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

  it('houseId 合法且绑定 ACTIVE 时通过', async () => {
    const { service, prisma } = makeService({ status: 'ACTIVE' });
    await expect(service.assertOwnerHouse('owner-1', 'house-1')).resolves.toBeUndefined();
    expect(prisma.raw.houseBinding.findUnique).toHaveBeenCalledWith({
      where: { wxUserId_houseId: { wxUserId: 'owner-1', houseId: 'house-1' } },
    });
  });
});
