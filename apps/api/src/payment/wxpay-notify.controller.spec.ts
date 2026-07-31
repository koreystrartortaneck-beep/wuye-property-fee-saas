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
