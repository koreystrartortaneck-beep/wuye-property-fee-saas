import { describeCallbackUrl, inspectCallbackUrls } from './callback-url';

/**
 * 2026-08-01 事故的收尾守卫。
 *
 * 事故经过：两笔支付微信已扣款，账单一直未缴。最终定性为**微信回调从未到达** ——
 * 依据是 WX_PAY_ALLOWED_TENANT_ID 已配置（所以验签失败必然会写 CRITICAL 告警），
 * 而告警表是 0 条：不是被拒，是没来过。
 *
 * 而「回调地址配得对不对」在此前没有任何地方能看出来：
 * WX_PAY_NOTIFY_URL 是必需环境变量，所以它一定有值 —— 但值可以是错的。
 * 配错的唯一表现就是「钱扣了、账单不变」，而这最像后端 bug，最难指向配置。
 *
 * 下面逐个钉住真实会犯的错法。每一条都对应一种「系统看起来正常、钱却收不到」。
 */

const OK = 'https://api.example.com/api/v1/payment/wxpay/notify';
const codes = (n?: string, r?: string) => inspectCallbackUrls(n, r).map((i) => i.code);

describe('回调地址形状自检', () => {
  it('正确的地址没有任何问题', () => {
    expect(inspectCallbackUrls(OK, undefined)).toEqual([]);
  });

  it('漏掉 /api/v1 前缀 —— 最常犯的一种，微信的回调会打到 404 上', () => {
    /*
     * 真实路由是 /api/v1/payment/wxpay/notify（setup-app.ts 里
     * app.setGlobalPrefix('api/v1')）。照着控制器路径写就会漏掉前缀，
     * 而漏掉之后一切照常：下单成功、微信扣款成功、回调 404、钱永远不入账。
     */
    expect(codes('https://api.example.com/payment/wxpay/notify')).toContain('NOTIFY_URL_PATH_MISMATCH');
  });

  it('提示里要同时给出期望路径和实际路径，配置的人才能照着改', () => {
    const [issue] = inspectCallbackUrls('https://api.example.com/payment/wxpay/notify', undefined);
    expect(issue.detail).toContain('/api/v1/payment/wxpay/notify');
    expect(issue.detail).toContain('/payment/wxpay/notify');
  });

  it('未配置 → 直接点名，不要报一个语法错', () => {
    expect(codes(undefined)).toEqual(['NOTIFY_URL_MISSING']);
    expect(codes('')).toEqual(['NOTIFY_URL_MISSING']);
  });

  it('不是合法 URL → 单独一类，不要继续往下判', () => {
    // 继续判会在 new URL 上抛异常，把就绪检查整个打挂
    expect(codes('这不是网址')).toEqual(['NOTIFY_URL_MALFORMED']);
    expect(() => inspectCallbackUrls('http://[', undefined)).not.toThrow();
  });

  it('http 不行 —— 微信只往 HTTPS 发回调', () => {
    expect(codes('http://api.example.com/api/v1/payment/wxpay/notify')).toContain('NOTIFY_URL_NOT_HTTPS');
  });

  it('地址不以 /notify 结尾时，退款回调地址会和支付回调撞成同一个', () => {
    /*
     * 退款回调地址的推导是 notifyUrl.replace(/\/notify$/, '/refund-notify')。
     * 若 notifyUrl 不以 /notify 结尾，替换不发生 —— 两个地址变成同一个，
     * 退款回调打到支付回调的处理器上，静默失败。
     * 这是「靠字符串替换推导配置」这种做法自带的陷阱，必须显式检出。
     */
    const got = codes('https://api.example.com/api/v1/payment/wxpay/notify-v2');
    expect(got).toContain('REFUND_URL_COLLIDES');
  });

  it('显式配了退款回调地址但路径写错 → 也要报', () => {
    expect(codes(OK, 'https://api.example.com/payment/wxpay/refund-notify')).toContain(
      'REFUND_URL_PATH_MISMATCH',
    );
  });

  it('显式配了正确的退款回调地址 → 无问题', () => {
    expect(inspectCallbackUrls(OK, 'https://api.example.com/api/v1/payment/wxpay/refund-notify')).toEqual([]);
  });

  it('多个问题同时存在时全部返回，不是只报第一个', () => {
    // 一次改对一个、跑一次才发现还有下一个，是最消耗人的排查方式
    const got = codes('http://api.example.com/payment/wxpay/x');
    expect(got).toContain('NOTIFY_URL_NOT_HTTPS');
    expect(got).toContain('NOTIFY_URL_PATH_MISMATCH');
    expect(got.length).toBeGreaterThanOrEqual(2);
  });
});

describe('路径常量必须跟真实路由一致', () => {
  it('从控制器与全局前缀反推，而不是靠人记', () => {
    /*
     * 这条守卫的意义：控制器路径或全局前缀一改，这里的期望值就过期了，
     * 于是自检开始报假警（或更糟：放过真的配错）。
     * 所以直接从源码读回来对一遍。
     */
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const read = (p: string) => fs.readFileSync(path.join(__dirname, p), 'utf8');

    const prefix = /setGlobalPrefix\('([^']+)'\)/.exec(read('../setup-app.ts'))?.[1];
    expect(prefix).toBe('api/v1');

    const notifySrc = read('wxpay-notify.controller.ts');
    const ctrl = /@Controller\('([^']+)'\)/.exec(notifySrc)?.[1];
    const route = /@Post\('([^']+)'\)/.exec(notifySrc)?.[1];
    expect(`/${prefix}/${ctrl}/${route}`).toBe('/api/v1/payment/wxpay/notify');

    const refundSrc = read('wxpay-refund-notify.controller.ts');
    const rCtrl = /@Controller\('([^']+)'\)/.exec(refundSrc)?.[1];
    const rRoute = /@Post\('([^']+)'\)/.exec(refundSrc)?.[1];
    expect(`/${prefix}/${rCtrl}/${rRoute}`).toBe('/api/v1/payment/wxpay/refund-notify');
  });
});

describe('显示用的摘要', () => {
  it('只给主机与路径', () => {
    expect(describeCallbackUrl(OK)).toBe('api.example.com/api/v1/payment/wxpay/notify');
  });

  it('未配置时给出明确文案，不是空字符串', () => {
    expect(describeCallbackUrl(undefined)).toBe('(未配置)');
  });

  it('值非法时原样回显——否则运营看不到自己填错成了什么', () => {
    expect(describeCallbackUrl('这不是网址')).toBe('这不是网址');
  });
});
