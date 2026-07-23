import { OwnerAnnouncementsController } from './owner-announcements.controller';

describe('OwnerAnnouncementsController 小区隔离', () => {
  function makeController(announcement: unknown, binding: unknown) {
    const prisma = {
      raw: {
        announcement: { findUnique: jest.fn().mockResolvedValue(announcement) },
        houseBinding: { findFirst: jest.fn().mockResolvedValue(binding) },
      },
    };
    const houses = { assertOwnerHouse: jest.fn() };
    const controller = new OwnerAnnouncementsController(prisma as never, houses as never);
    return { controller, prisma };
  }

  it('小区公告：本人须在该公告小区有 ACTIVE 绑定', async () => {
    const { controller, prisma } = makeController(
      { id: 'a1', tenantId: 't1', communityId: 'c1', status: 'PUBLISHED' },
      { id: 'b1' },
    );
    await expect(controller.detail({ ownerId: 'wx-1' }, 'a1')).resolves.toMatchObject({ id: 'a1' });
    expect(prisma.raw.houseBinding.findFirst).toHaveBeenCalledWith({
      where: { wxUserId: 'wx-1', status: 'ACTIVE', house: { communityId: 'c1' } },
    });
  });

  it('跨小区访问被拒（仅同租户其他小区绑定不足以查看小区公告）', async () => {
    const { controller } = makeController(
      { id: 'a1', tenantId: 't1', communityId: 'c1', status: 'PUBLISHED' },
      null, // 该公告小区 c1 内无 ACTIVE 绑定
    );
    await expect(controller.detail({ ownerId: 'wx-1' }, 'a1')).rejects.toMatchObject({ code: 41001 });
  });

  it('全租户公告（communityId 为空）按租户校验绑定', async () => {
    const { controller, prisma } = makeController(
      { id: 'a2', tenantId: 't1', communityId: null, status: 'PUBLISHED' },
      { id: 'b1' },
    );
    await controller.detail({ ownerId: 'wx-1' }, 'a2');
    expect(prisma.raw.houseBinding.findFirst).toHaveBeenCalledWith({
      where: { wxUserId: 'wx-1', status: 'ACTIVE', tenantId: 't1' },
    });
  });

  it('未发布公告返回 40400', async () => {
    const { controller } = makeController({ id: 'a1', status: 'DRAFT' }, { id: 'b1' });
    await expect(controller.detail({ ownerId: 'wx-1' }, 'a1')).rejects.toMatchObject({ code: 40400 });
  });
});
