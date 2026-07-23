import { Controller, Logger, Post, RawBodyRequest, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { RefundService } from './refund.service';
import { WxPayDirectProvider } from './wxpay-direct.provider';

@Controller('payment/wxpay')
export class WxPayRefundNotifyController {
  private readonly logger = new Logger(WxPayRefundNotifyController.name);

  constructor(
    private readonly wxPay: WxPayDirectProvider,
    private readonly refunds: RefundService,
  ) {}

  @Post('refund-notify')
  async notify(req: RawBodyRequest<Request>, @Res() res: Response): Promise<void> {
    try {
      if (!req.rawBody) throw new Error('退款回调缺少原始请求体');
      const refund = this.wxPay.parseRefundNotification(req.headers, req.rawBody);
      await this.refunds.handleRefundNotification(refund);
      res.status(200).json({ code: 'SUCCESS', message: '成功' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`微信退款回调拒绝：${message}`);
      res.status(401).json({ code: 'FAIL', message: '签名验证失败' });
    }
  }
}
