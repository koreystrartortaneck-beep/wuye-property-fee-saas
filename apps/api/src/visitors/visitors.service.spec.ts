import { ErrorCode } from '@pf/shared';
import { VisitorsService, passShanghaiDay, shanghaiToday } from './visitors.service';

/**
 * 访客通行码：时区与并发。
 *
 * 按覆盖率找过来的（这个文件原本 17%）。两个真缺陷：
 *
 * ① 「是否当日」两边都用**服务器本地日**，而生产容器跑在 UTC。
 *    北京时间 0:00~8:00 之间 UTC 还是前一天，于是当天有效的码被判「不在有效日期」——
 *    访客在门口被拦，业主明明约的是今天。反过来昨天的码在那几个小时里还能过。
 *    夜班、晚归、清早送货都落在这个窗口，不是边角情况。
 *
 * ② 核销是「查到 ACTIVE 再无条件 update」。两个岗亭同时扫同一个码，两人都进来了。
 *    与刚修的卡券核销同一个形状 —— 支付侧的 consumeCouponInTx 一直是对的，
 *    这两处漏了同一份保护。
 */

/** 北京 0:30 的那一刻（UTC 前一天 16:30）——就是原实现出错的窗口 */
const BEIJING_0030_JUL5 = Date.UTC(2026, 6, 4, 16, 30);
/** 北京 12:00 同一天（UTC 04:00）——窗口之外，用来证明修法没把正常情形改坏 */
const BEIJING_1200_JUL5 = Date.UTC(2026, 6, 5, 4, 0);

/** visitDate 的存库形态：该日期在服务器本地时区的零点 */
const storedDay = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe('北京日的换算', () => {
  it('凌晨 0:30 的北京日是当天，而不是 UTC 的前一天', () => {
    expect(shanghaiToday(BEIJING_0030_JUL5)).toBe('2026-07-05');
    // 若用 UTC 日会得到 07-04 —— 这正是缺陷的来源
    expect(new Date(BEIJING_0030_JUL5).toISOString().slice(0, 10)).toBe('2026-07-04');
  });

  it('存库值换算回北京日与展示口径一致', () => {
    // 展示侧 fmtDate 也是 +8，两者必须得出同一天，否则「看到的」和「判定的」不是一回事
    expect(passShanghaiDay(storedDay(2026, 7, 5))).toBe('2026-07-05');
  });
});

describe('核销：北京 0~8 点这个窗口', () => {
  function makeSvc(pass: Record<string, unknown> | null, updateCount = 1) {
    const updateMany = jest.fn(async () => ({ count: updateCount }));
    const prisma = {
      t: { visitorPass: { findUnique: jest.fn(async () => pass), updateMany } },
      raw: {},
    };
    return { svc: new VisitorsService(prisma as never, {} as never), updateMany };
  }

  const activePass = (y: number, m: number, d: number) => ({
    id: 'p1',
    status: 'ACTIVE',
    visitDate: storedDay(y, m, d),
    visitorName: '来客',
  });

  afterEach(() => jest.restoreAllMocks());

  it('北京 0:30 核销当天的码 → 放行（原实现会拦下）', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(BEIJING_0030_JUL5);
    const { svc, updateMany } = makeSvc(activePass(2026, 7, 5));
    const r = (await svc.verify('p1')) as { status: string };
    expect(r.status).toBe('USED');
    expect(updateMany).toHaveBeenCalled();
  });

  it('北京 0:30 核销昨天的码 → 拒绝（原实现会放行）', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(BEIJING_0030_JUL5);
    const { svc } = makeSvc(activePass(2026, 7, 4));
    await expect(svc.verify('p1')).rejects.toMatchObject({ code: ErrorCode.PASS_STATE_INVALID.code });
  });

  it('白天的正常情形没被改坏', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(BEIJING_1200_JUL5);
    const { svc } = makeSvc(activePass(2026, 7, 5));
    const r = (await svc.verify('p1')) as { status: string };
    expect(r.status).toBe('USED');
  });

  it('明天的码当天核不了', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(BEIJING_1200_JUL5);
    const { svc } = makeSvc(activePass(2026, 7, 6));
    await expect(svc.verify('p1')).rejects.toMatchObject({ code: ErrorCode.PASS_STATE_INVALID.code });
  });
});

describe('核销的并发', () => {
  function makeSvc(updateCount: number) {
    const prisma = {
      t: {
        visitorPass: {
          findUnique: jest.fn(async () => ({
            id: 'p1',
            status: 'ACTIVE',
            visitDate: storedDay(2026, 7, 5),
          })),
          updateMany: jest.fn(async () => ({ count: updateCount })),
        },
      },
      raw: {},
    };
    return new VisitorsService(prisma as never, {} as never);
  }

  afterEach(() => jest.restoreAllMocks());

  it('带 status: ACTIVE 条件更新，不是无条件 update', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(BEIJING_1200_JUL5);
    const prismaCalls: unknown[] = [];
    const prisma = {
      t: {
        visitorPass: {
          findUnique: jest.fn(async () => ({ id: 'p1', status: 'ACTIVE', visitDate: storedDay(2026, 7, 5) })),
          updateMany: jest.fn(async (args: unknown) => {
            prismaCalls.push(args);
            return { count: 1 };
          }),
        },
      },
      raw: {},
    };
    await new VisitorsService(prisma as never, {} as never).verify('p1');
    expect(prismaCalls[0]).toMatchObject({ where: { id: 'p1', status: 'ACTIVE' } });
  });

  it('条件不成立（另一个岗亭刚核过）时报错，而不是当作成功', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(BEIJING_1200_JUL5);
    await expect(makeSvc(0).verify('p1')).rejects.toMatchObject({
      code: ErrorCode.PASS_STATE_INVALID.code,
    });
  });
});

describe('通行码不能用可预测的随机源', () => {
  it('不使用 Math.random', () => {
    // 物业凭码放行；可预测的码意味着别人能算出你的码
    const src = require('node:fs')
      .readFileSync(require('node:path').join(__dirname, 'visitors.service.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toContain('Math.random');
    expect(src).toContain('randomInt(100000, 1000000)');
  });
});
