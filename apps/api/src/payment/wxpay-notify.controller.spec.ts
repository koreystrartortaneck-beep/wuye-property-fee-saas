import { WxPayNotifyController } from './wxpay-notify.controller';
import type { WxPayDirectProvider } from './wxpay-direct.provider';
import type { PaymentService } from './payment.service';

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

  it('验签解密并入账后返回微信要求的原始成功报文', async () => {
    const transaction = { out_trade_no: 'WY1' };
    const provider = { parseNotification: jest.fn().mockReturnValue(transaction) };
    const service = { handleWxPaySuccess: jest.fn().mockResolvedValue({ status: 'SUCCESS' }) };
    const controller = new WxPayNotifyController(provider as unknown as WxPayDirectProvider, service as unknown as PaymentService);
    const res = response();
    const rawBody = Buffer.from('{"id":"event"}');

    await controller.notify({ headers: { 'wechatpay-serial': 'serial' }, rawBody } as never, res as never);

    expect(provider.parseNotification).toHaveBeenCalledWith(expect.any(Object), rawBody);
    expect(service.handleWxPaySuccess).toHaveBeenCalledWith(transaction);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ code: 'SUCCESS', message: '成功' });
  });

  it('验签失败时返回 401，不能被全局 HTTP 200 协议吞掉', async () => {
    const provider = { parseNotification: jest.fn(() => { throw new Error('验签失败'); }) };
    const service = { handleWxPaySuccess: jest.fn() };
    const controller = new WxPayNotifyController(provider as unknown as WxPayDirectProvider, service as unknown as PaymentService);
    const res = response();

    await controller.notify({ headers: {}, rawBody: Buffer.from('{}') } as never, res as never);

    expect(service.handleWxPaySuccess).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ code: 'FAIL', message: '签名验证失败' });
  });
});
