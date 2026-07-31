import { WxPayRefundNotifyController } from './wxpay-refund-notify.controller';
import type { WxPayDirectProvider } from './wxpay-direct.provider';
import type { RefundService } from './refund.service';

/**
 * 退款回调与支付回调走同一套验签，同样需要四个头齐全。
 * 原测试 headers 传 {}、断言用 expect.any(Object)，两边都是空壳。
 */
const SIGNED_HEADERS = {
  'wechatpay-serial': 'serial',
  'wechatpay-timestamp': '1780000000',
  'wechatpay-nonce': 'nonce123',
  'wechatpay-signature': 'c2ln',
} as const;

describe('WxPayRefundNotifyController', () => {
  function response() {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    return res;
  }

  it('验签解密并处理退款回调后返回成功报文', async () => {
    const refund = { out_refund_no: 'RF-1' };
    const provider = { parseRefundNotification: jest.fn().mockReturnValue(refund) };
    const service = { handleRefundNotification: jest.fn().mockResolvedValue({ status: 'SUCCESS' }) };
    const controller = new WxPayRefundNotifyController(provider as unknown as WxPayDirectProvider, service as unknown as RefundService);
    const res = response();
    const rawBody = Buffer.from('{"id":"evt"}');

    await controller.notify({ headers: SIGNED_HEADERS, rawBody } as never, res as never);

    // 四个签名头必须逐字传到 provider —— 它们是验签的唯一输入。
    // expect.any(Object) 连 {} 都满足，等于不校验。
    expect(provider.parseRefundNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        'wechatpay-serial': expect.any(String),
        'wechatpay-timestamp': expect.any(String),
        'wechatpay-nonce': expect.any(String),
        'wechatpay-signature': expect.any(String),
      }),
      rawBody,
    );
    expect(service.handleRefundNotification).toHaveBeenCalledWith(refund);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ code: 'SUCCESS', message: '成功' });
  });

  it('验签失败时返回 401', async () => {
    const provider = { parseRefundNotification: jest.fn(() => { throw new Error('验签失败'); }) };
    const service = { handleRefundNotification: jest.fn() };
    const controller = new WxPayRefundNotifyController(provider as unknown as WxPayDirectProvider, service as unknown as RefundService);
    const res = response();

    await controller.notify({ headers: {}, rawBody: Buffer.from('{}') } as never, res as never);

    expect(service.handleRefundNotification).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
