import { ErrorCode } from '@pf/shared';
import { ServicesService } from './services.service';

/**
 * 生活服务下单：小区范围与日期。
 *
 * 按覆盖率找过来的（这个文件原本 17%）。
 *
 * 缺陷：createOrder 只校验了 tenantId，**没校验 communityId**。
 * availableItems 按「本小区或公司通用」过滤，但下单不过滤 ——
 * 业主把另一个小区的 serviceItemId 传进来就能预约不属于自己小区的服务。
 * 服务价格按小区定，也可能是某小区的专属福利，所以这是实打实的越权，
 * 不只是「看到了不该看的」。券的消费路径一直做了这件事，这里漏了。
 */

const HOUSE = { id: 'h1', tenantId: 't1', communityId: 'c1' };
const BASE_DTO = {
  houseId: 'h1',
  serviceItemId: 'si1',
  contactName: '张三',
  contactPhone: '13800000000',
  expectDate: '2099-01-01',
};

function makeSvc(item: Record<string, unknown> | null) {
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'o1', ...data }));
  const prisma = {
    raw: {
      house: { findUnique: jest.fn(async () => HOUSE) },
      serviceItem: { findUnique: jest.fn(async () => item) },
      serviceOrder: { create },
    },
  };
  const houses = { assertOwnerHouse: jest.fn(async () => undefined) };
  return { svc: new ServicesService(prisma as never, houses as never), create, houses };
}

const item = (over: Record<string, unknown> = {}) => ({
  id: 'si1',
  tenantId: 't1',
  communityId: 'c1',
  enabled: true,
  name: '家电清洗',
  price: '120.00',
  unit: '元/次',
  ...over,
});

describe('下单的小区范围', () => {
  it('本小区的服务可以下单', async () => {
    const { svc, create } = makeSvc(item());
    await svc.createOrder('o-1', BASE_DTO);
    expect(create).toHaveBeenCalled();
  });

  it('公司通用服务（communityId 为 null）可以下单', async () => {
    const { svc, create } = makeSvc(item({ communityId: null }));
    await svc.createOrder('o-1', BASE_DTO);
    expect(create).toHaveBeenCalled();
  });

  it('别的小区的服务不能下单——这正是原来的漏洞', async () => {
    const { svc, create } = makeSvc(item({ communityId: 'c2' }));
    await expect(svc.createOrder('o-1', BASE_DTO)).rejects.toMatchObject({
      code: ErrorCode.SERVICE_UNAVAILABLE.code,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('别的租户的服务不能下单', async () => {
    const { svc } = makeSvc(item({ tenantId: 't2' }));
    await expect(svc.createOrder('o-1', BASE_DTO)).rejects.toMatchObject({
      code: ErrorCode.SERVICE_UNAVAILABLE.code,
    });
  });

  it('已停用的服务不能下单', async () => {
    const { svc } = makeSvc(item({ enabled: false }));
    await expect(svc.createOrder('o-1', BASE_DTO)).rejects.toMatchObject({
      code: ErrorCode.SERVICE_UNAVAILABLE.code,
    });
  });

  it('先校验房屋归属，再查服务', async () => {
    // 顺序反了就是「先替别人家下单再拒绝」
    const { svc, houses } = makeSvc(item());
    await svc.createOrder('o-1', BASE_DTO);
    expect(houses.assertOwnerHouse).toHaveBeenCalledWith('o-1', 'h1');
  });

  it('价格与名称取服务端快照，不接收前端传值', async () => {
    /*
     * 下单载荷里没有 price/serviceName 字段，值全部来自 ServiceItem。
     * 若哪天为了「省一次查询」改成前端传，业主就能自己定价。
     */
    const { svc, create } = makeSvc(item({ price: '999.00', name: '深度保洁' }));
    await svc.createOrder('o-1', { ...BASE_DTO, price: '0.01', serviceName: '白拿' } as never);
    expect(create.mock.calls[0][0].data).toMatchObject({ price: '999.00', serviceName: '深度保洁' });
  });
});

describe('期望上门日期', () => {
  afterEach(() => jest.restoreAllMocks());

  it('过去的日期被拒绝', async () => {
    /*
     * DTO 只校验 YYYY-MM-DD 的形状。传 2020-01-01 会建出一个「期望日期已过」的订单，
     * 在物业的待接单列表里还排最前（按 expectDate 排序），接了也没法上门。
     */
    const { svc } = makeSvc(item());
    await expect(svc.createOrder('o-1', { ...BASE_DTO, expectDate: '2020-01-01' })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION.code,
    });
  });

  it('今天可以预约（不能把当天也挡掉）', async () => {
    // 北京 23:00（UTC 15:00）：若用 UTC 日判定，当天会被误判成「已过」
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 6, 5, 15, 0));
    const { svc, create } = makeSvc(item());
    await svc.createOrder('o-1', { ...BASE_DTO, expectDate: '2026-07-05' });
    expect(create).toHaveBeenCalled();
  });

  it('北京凌晨也按北京日算', async () => {
    // 北京 0:30（UTC 前一日 16:30）：当天必须还能约
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 6, 4, 16, 30));
    const { svc, create } = makeSvc(item());
    await svc.createOrder('o-1', { ...BASE_DTO, expectDate: '2026-07-05' });
    expect(create).toHaveBeenCalled();
  });
});
