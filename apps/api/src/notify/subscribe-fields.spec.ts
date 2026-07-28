import { DEFAULT_SUBSCRIBE_FIELDS, buildSubscribeData, subscribeFieldNames } from './subscribe-fields';

/**
 * 起因：后端两处都把订阅消息的 data 键写成业务语义名（title / amount / period /
 * dueDate），而微信要求键必须是模板字段名（thing1 / amount2 / date3 …）。
 * 结果是即便模板 ID 配好了，通知依然一条都发不出去，管理端只看到一句 errcode。
 * 生产实测 16 条通知记录全部 FAILED/SKIPPED。
 *
 * 这些用例锁住：键一定是微信字段名、三类通知文案不同、thing 类不超 20 字、
 * 以及环境变量可以覆盖字段名（模板字段名对不上时不必重新发布）。
 */
describe('订阅消息字段映射', () => {
  const KEYS = [
    'WX_TMPL_FIELD_FEE_NAME',
    'WX_TMPL_FIELD_AMOUNT',
    'WX_TMPL_FIELD_DUE_DATE',
    'WX_TMPL_FIELD_TIP',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const bill = { title: '住宅物业费 2026-09', amount: '250.00', dueDate: '2026-08-26' };

  it('data 的键是微信模板字段名，绝不是业务语义名', () => {
    const data = buildSubscribeData('BILL_CREATED', bill);
    expect(Object.keys(data).sort()).toEqual(['amount2', 'date3', 'thing1', 'thing4']);
    // 这四个是修复前实际发出去的键，微信一律判 47003
    for (const wrong of ['title', 'amount', 'period', 'dueDate']) {
      expect(data).not.toHaveProperty(wrong);
    }
  });

  it('值取自账单事实：费用名称、金额带单位、到期日期', () => {
    const data = buildSubscribeData('BILL_CREATED', bill);
    expect(data.thing1).toBe('住宅物业费 2026-09');
    expect(data.amount2).toBe('250.00元');
    expect(data.date3).toBe('2026-08-26');
  });

  it('三类通知的温馨提示各不相同，且都在 thing 类 20 字上限内', () => {
    const tips = (['BILL_CREATED', 'DUE_SOON', 'OVERDUE'] as const).map(
      (t) => buildSubscribeData(t, bill).thing4,
    );
    expect(new Set(tips).size).toBe(3);
    for (const tip of tips) expect(tip.length).toBeLessThanOrEqual(20);
  });

  it('费用名称超过 20 字时由发送层截断，映射层不擅自改写业务数据', () => {
    const long = '超长费用名称'.repeat(10);
    expect(buildSubscribeData('BILL_CREATED', { ...bill, title: long }).thing1).toBe(long);
  });

  it('字段名可用环境变量覆盖：线上模板字段名与预期不符时无需重新发布', () => {
    expect(subscribeFieldNames()).toEqual(DEFAULT_SUBSCRIBE_FIELDS);
    process.env.WX_TMPL_FIELD_FEE_NAME = 'thing5';
    process.env.WX_TMPL_FIELD_DUE_DATE = 'date2';
    const data = buildSubscribeData('OVERDUE', bill);
    expect(data.thing5).toBe('住宅物业费 2026-09');
    expect(data.date2).toBe('2026-08-26');
    expect(data).not.toHaveProperty('thing1');
    expect(data).not.toHaveProperty('date3');
  });
});
