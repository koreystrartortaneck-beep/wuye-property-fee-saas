import { Controller, Logger, Post, RawBodyRequest, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { PaymentService } from './payment.service';
import { WxPayDirectProvider } from './wxpay-direct.provider';

@Controller('payment/wxpay')
export class WxPayNotifyController {
  private readonly logger = new Logger(WxPayNotifyController.name);

  constructor(
    private readonly wxPay: WxPayDirectProvider,
    private readonly paymentService: PaymentService,
  ) {}

  @Post('notify')
  async notify(req: RawBodyRequest<Request>, @Res() res: Response): Promise<void> {
    try {
      if (!req.rawBody) throw new Error('支付回调缺少原始请求体');
      const transaction = this.wxPay.parseNotification(req.headers, req.rawBody);
      await this.paymentService.handleWxPaySuccess(transaction);
      res.status(200).json({ code: 'SUCCESS', message: '成功' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`微信支付回调拒绝：${message}`);
      res.status(401).json({ code: 'FAIL', message: '签名验证失败' });
    }
  }
}
