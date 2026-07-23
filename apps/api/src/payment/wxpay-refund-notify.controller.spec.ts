import { WxPayRefundNotifyController } from './wxpay-refund-notify.controller';
import type { WxPayDirectProvider } from './wxpay-direct.provider';
import type { RefundService } from './refund.service';

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

    await controller.notify({ headers: {}, rawBody } as never, res as never);

    expect(provider.parseRefundNotification).toHaveBeenCalledWith(expect.any(Object), rawBody);
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
