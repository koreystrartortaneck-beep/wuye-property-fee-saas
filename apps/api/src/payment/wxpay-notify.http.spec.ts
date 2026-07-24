import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PaymentService } from './payment.service';
import { RefundService } from './refund.service';
import { WxPayDirectProvider } from './wxpay-direct.provider';
import { WxPayNotifyController } from './wxpay-notify.controller';
import { WxPayRefundNotifyController } from './wxpay-refund-notify.controller';

/**
 * HTTP 级回归：真实经 NestJS 参数绑定跑一遍回调端点。
 * 守护 "req 参数漏 @Req() 装饰器 → req 为 undefined → 读 req.rawBody 崩溃返 401" 这类 bug——
 * 直接 new Controller().notify(mockReq,res) 的单测无法覆盖 HTTP 参数绑定，故必须走真实 app。
 */
describe('微信回调端点 HTTP 参数绑定回归', () => {
  it('支付回调：真实 POST 时 req.rawBody 应被注入并透传给 parseNotification，返回 200', async () => {
    const parseNotification = jest.fn().mockReturnValue({ out_trade_no: 'WY1', trade_state: 'SUCCESS' });
    const handleWxPayNotification = jest.fn().mockResolvedValue({ status: 'SUCCESS' });
    const moduleRef = await Test.createTestingModule({
      controllers: [WxPayNotifyController],
      providers: [
        { provide: WxPayDirectProvider, useValue: { parseNotification } },
        { provide: PaymentService, useValue: { handleWxPayNotification } },
      ],
    }).compile();
    const app: INestApplication = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    try {
      const res = await request(app.getHttpServer())
        .post('/payment/wxpay/notify')
        .set('Content-Type', 'application/json')
        .send({ id: 'evt-pay', event_type: 'TRANSACTION.SUCCESS' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ code: 'SUCCESS', message: '成功' });
      expect(parseNotification).toHaveBeenCalledTimes(1);
      const rawBody = parseNotification.mock.calls[0][1];
      expect(Buffer.isBuffer(rawBody)).toBe(true);
      expect(rawBody.toString()).toContain('evt-pay');
      expect(handleWxPayNotification).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('退款回调：真实 POST 时 req.rawBody 应被注入并透传给 parseRefundNotification，返回 200', async () => {
    const parseRefundNotification = jest.fn().mockReturnValue({ out_refund_no: 'RF1', refund_status: 'SUCCESS' });
    const handleRefundNotification = jest.fn().mockResolvedValue({ status: 'SUCCESS' });
    const moduleRef = await Test.createTestingModule({
      controllers: [WxPayRefundNotifyController],
      providers: [
        { provide: WxPayDirectProvider, useValue: { parseRefundNotification } },
        { provide: RefundService, useValue: { handleRefundNotification } },
      ],
    }).compile();
    const app: INestApplication = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    try {
      const res = await request(app.getHttpServer())
        .post('/payment/wxpay/refund-notify')
        .set('Content-Type', 'application/json')
        .send({ id: 'evt-refund', event_type: 'REFUND.SUCCESS' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ code: 'SUCCESS', message: '成功' });
      expect(parseRefundNotification).toHaveBeenCalledTimes(1);
      const rawBody = parseRefundNotification.mock.calls[0][1];
      expect(Buffer.isBuffer(rawBody)).toBe(true);
      expect(rawBody.toString()).toContain('evt-refund');
      expect(handleRefundNotification).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
