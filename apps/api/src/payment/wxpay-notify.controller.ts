import { Controller, Logger, Optional, Post, RawBodyRequest, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { AlertService } from '../operations/alert.service';
import { emitCallbackRejectedAlert } from './wxpay-alert.util';
import { PaymentService } from './payment.service';
import { WxPayDirectProvider } from './wxpay-direct.provider';

@Controller('payment/wxpay')
export class WxPayNotifyController {
  private readonly logger = new Logger(WxPayNotifyController.name);

  constructor(
    private readonly wxPay: WxPayDirectProvider,
    private readonly paymentService: PaymentService,
    @Optional() private readonly alerts: AlertService | null = null,
  ) {}

  @Post('notify')
  async notify(@Req() req: RawBodyRequest<Request>, @Res() res: Response): Promise<void> {
    try {
      if (!req.rawBody) throw new Error('支付回调缺少原始请求体');
      const transaction = this.wxPay.parseNotification(req.headers, req.rawBody);
      await this.paymentService.handleWxPayNotification(transaction);
      res.status(200).json({ code: 'SUCCESS', message: '成功' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`微信支付回调拒绝：${message}`);
      await emitCallbackRejectedAlert(this.alerts, 'PAYMENT_CALLBACK_REJECTED', '微信支付回调验签失败', message);
      res.status(401).json({ code: 'FAIL', message: '签名验证失败' });
    }
  }
}
