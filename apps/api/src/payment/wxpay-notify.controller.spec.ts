import { WxPayNotifyController } from './wxpay-notify.controller';
import type { WxPayDirectProvider } from './wxpay-direct.provider';
import type { PaymentService } from './payment.service';

/**
 * 真实微信支付回调携带的四个签名头。验签需要它们**全部**：serial 定位平台证书、
 * timestamp+nonce+body 拼出待签串、signature 是签名本身。
 *
 * 此前测试只构造 serial 一个头，断言又写成 expect.any(Object)（{} 也满足）。
 * 实测把 controller 改成 parseNotification({}, rawBody)——生产上验签永远不通过、
 * 每一笔到账都被拒、钱到了系统不知道——421 个后端用例全绿。
 */
const SIGNED_HEADERS = {
  'wechatpay-serial': 'serial',
  'wechatpay-timestamp': '1780000000',
  'wechatpay-nonce': 'nonce123',
  'wechatpay-signature': 'c2ln',
} as const;

describe('WxPayNotifyController', () => {
  function response() {
    const res = {
      status: jest.fn(),
      json: jest.fn(),
    };
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    return res;
  }

  it('验签解密并记录回调证据入账后返回微信要求的原始成功报文', async () => {
    const transaction = { out_trade_no: 'WY1' };
    const provider = { parseNotification: jest.fn().mockReturnValue(transaction) };
    const service = { handleWxPayNotification: jest.fn().mockResolvedValue({ status: 'SUCCESS' }) };
    const controller = new WxPayNotifyController(provider as unknown as WxPayDirectProvider, service as unknown as PaymentService);
    const res = response();
    const rawBody = Buffer.from('{"id":"event"}');

    await controller.notify({ headers: SIGNED_HEADERS, rawBody } as never, res as never);

    // headers 必须逐字传到 provider：那四个头是验签的**唯一**输入。
    // 原断言用 expect.any(Object)，{} 也满足——实测把 controller 改成传 {} 之后
    // 421 个后端用例全绿，而生产上验签会永远失败、每一笔到账都被拒。
    expect(provider.parseNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        'wechatpay-serial': expect.any(String),
        'wechatpay-timestamp': expect.any(String),
        'wechatpay-nonce': expect.any(String),
        'wechatpay-signature': expect.any(String),
      }),
      rawBody,
    );
    expect(service.handleWxPayNotification).toHaveBeenCalledWith(transaction);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ code: 'SUCCESS', message: '成功' });
  });

  it('验签失败时返回 401，不能被全局 HTTP 200 协议吞掉', async () => {
    const provider = { parseNotification: jest.fn(() => { throw new Error('验签失败'); }) };
    const service = { handleWxPayNotification: jest.fn() };
    const controller = new WxPayNotifyController(provider as unknown as WxPayDirectProvider, service as unknown as PaymentService);
    const res = response();

    await controller.notify({ headers: {}, rawBody: Buffer.from('{}') } as never, res as never);

    expect(service.handleWxPayNotification).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ code: 'FAIL', message: '签名验证失败' });
  });
});

/**
 * 验签失败 vs 处理失败，必须区分开。
 *
 * 原实现两者共用一个 catch：都记「微信支付回调拒绝」、都回 401「签名验证失败」。
 * 后果有两层：
 *   ① 响应与日志都指向验签，把排查往错的方向带 ——
 *      2026-08-01 事故里我正是因此先误判成「回调从未到达 / 验签被拒」；
 *   ② 处理失败时**明明知道是哪一笔订单**，却只发一条按小时去重的全局告警，
 *      而那条告警在 WX_PAY_ALLOWED_TENANT_ID 缺失时还会静默 return。
 *      于是一笔已扣款的订单出问题，系统里可以完全没有痕迹。
 */
describe('回调失败必须留下能定位到订单的痕迹', () => {
  const SIGNED = {
    'wechatpay-serial': 'serial',
    'wechatpay-timestamp': '1780000000',
    'wechatpay-nonce': 'nonce123',
    'wechatpay-signature': 'c2ln',
  } as const;

  function response() {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    return res;
  }

  function setup(opts: { parseThrows?: boolean; handleThrows?: string }) {
    const transaction = { out_trade_no: 'WY20260801844562', transaction_id: 'TXN1' };
    const provider = {
      parseNotification: opts.parseThrows
        ? jest.fn(() => {
            throw new Error('签名不匹配');
          })
        : jest.fn().mockReturnValue(transaction),
    };
    const service = {
      handleWxPayNotification: opts.handleThrows
        ? jest.fn().mockRejectedValue(new Error(opts.handleThrows))
        : jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
      recordNotifyFailure: jest.fn().mockResolvedValue(undefined),
    };
    const safeEmit = jest.fn().mockResolvedValue(undefined);
    const controller = new WxPayNotifyController(
      provider as never,
      service as never,
      { safeEmit } as never,
    );
    return { controller, service, safeEmit, res: response() };
  }

  it('处理失败 → 回 500 而不是 401（响应不能撒谎说是验签问题）', async () => {
    const { controller, res } = setup({ handleThrows: '支付入账被并发跳过且未真正成功' });
    process.env.WX_PAY_ALLOWED_TENANT_ID = 't1';
    await controller.notify({ headers: SIGNED, rawBody: Buffer.from('{}') } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('处理失败 → 必须回非 2xx，否则微信认定已受理、永不重试', async () => {
    /*
     * 这是这条守卫里最重要的一条。微信只在非 2xx 时按退避重试，
     * 而重试是「钱自己回来」的主要途径。回 200 等于放弃这笔钱。
     */
    const { controller, res } = setup({ handleThrows: 'boom' });
    await controller.notify({ headers: SIGNED, rawBody: Buffer.from('{}') } as never, res as never);
    const status = res.status.mock.calls[0][0] as number;
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it('处理失败 → 在这笔订单上落一条失败痕迹（带订单号和交易号）', async () => {
    const { controller, service, res } = setup({ handleThrows: '关联账单状态异常' });
    await controller.notify({ headers: SIGNED, rawBody: Buffer.from('{}') } as never, res as never);
    expect(service.recordNotifyFailure).toHaveBeenCalledWith(
      'WY20260801844562',
      'TXN1',
      expect.stringContaining('关联账单状态异常'),
    );
  });

  it('处理失败的告警要带订单号——按小时去重的全局告警不带订单号就定位不到人', async () => {
    process.env.WX_PAY_ALLOWED_TENANT_ID = 't1';
    const { controller, safeEmit, res } = setup({ handleThrows: 'boom' });
    await controller.notify({ headers: SIGNED, rawBody: Buffer.from('{}') } as never, res as never);
    expect(safeEmit).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringContaining('WY20260801844562') }),
    );
    delete process.env.WX_PAY_ALLOWED_TENANT_ID;
  });

  it('验签失败 → 仍然回 401，且不去写订单痕迹（此时拿不到订单号）', async () => {
    const { controller, service, res } = setup({ parseThrows: true });
    await controller.notify({ headers: SIGNED, rawBody: Buffer.from('{}') } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(service.recordNotifyFailure).not.toHaveBeenCalled();
  });

  it('成功路径不受影响：回 200 + 微信要求的 SUCCESS 报文', async () => {
    const { controller, service, res } = setup({});
    await controller.notify({ headers: SIGNED, rawBody: Buffer.from('{}') } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ code: 'SUCCESS', message: '成功' });
    expect(service.recordNotifyFailure).not.toHaveBeenCalled();
  });
});
