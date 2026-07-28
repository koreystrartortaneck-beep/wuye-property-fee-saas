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

  it('data 的键是模板详情里的真实字段名，绝不是业务语义名', () => {
    const data = buildSubscribeData('BILL_CREATED', bill);
    // 取自公众平台模板详情（模板 33214）：thing12 / amount4 / time3 / thing11
    expect(Object.keys(data).sort()).toEqual(['amount4', 'thing11', 'thing12', 'time3']);
    // 这四个是修复前实际发出去的键，微信一律判 47003
    for (const wrong of ['title', 'amount', 'period', 'dueDate']) {
      expect(data).not.toHaveProperty(wrong);
    }
    // 最初按惯例猜的四个字段名同样不能出现
    for (const guessed of ['thing1', 'amount2', 'date3', 'thing4']) {
      expect(data).not.toHaveProperty(guessed);
    }
  });

  it('值格式与微信示例卡片一致：金额带币种符号、到期日期为年月日', () => {
    const data = buildSubscribeData('BILL_CREATED', bill);
    expect(data.thing12).toBe('住宅物业费 2026-09');
    expect(data.amount4).toBe('￥250.00');
    expect(data.time3).toBe('2026年8月26日');
  });

  it('到期日期按上海时区格式化：UTC 16:00 属于次日，不能少算一天', () => {
    // 2026-08-26T16:00:00Z = 上海 2026-08-27 00:00
    const data = buildSubscribeData('BILL_CREATED', {
      ...bill,
      dueDate: new Date('2026-08-26T16:00:00.000Z'),
    });
    expect(data.time3).toBe('2026年8月27日');
  });

  it('到期日期无法解析时原样透传，不产出「NaN年NaN月」这种脏值', () => {
    const data = buildSubscribeData('BILL_CREATED', { ...bill, dueDate: '待定' });
    expect(data.time3).toBe('待定');
  });

  it('三类通知的温馨提示各不相同，且都在 thing 类 20 字上限内', () => {
    const tips = (['BILL_CREATED', 'DUE_SOON', 'OVERDUE'] as const).map(
      (t) => buildSubscribeData(t, bill).thing11,
    );
    expect(new Set(tips).size).toBe(3);
    for (const tip of tips) expect(tip.length).toBeLessThanOrEqual(20);
  });

  it('费用名称超过 20 字时由发送层截断，映射层不擅自改写业务数据', () => {
    const long = '超长费用名称'.repeat(10);
    expect(buildSubscribeData('BILL_CREATED', { ...bill, title: long }).thing12).toBe(long);
  });

  it('字段名可用环境变量覆盖：线上模板字段名与预期不符时无需重新发布', () => {
    expect(subscribeFieldNames()).toEqual(DEFAULT_SUBSCRIBE_FIELDS);
    process.env.WX_TMPL_FIELD_FEE_NAME = 'thing5';
    process.env.WX_TMPL_FIELD_DUE_DATE = 'date2';
    const data = buildSubscribeData('OVERDUE', bill);
    expect(data.thing5).toBe('住宅物业费 2026-09');
    expect(data.date2).toBe('2026年8月26日');
    expect(data).not.toHaveProperty('thing12');
    expect(data).not.toHaveProperty('time3');
  });
});
