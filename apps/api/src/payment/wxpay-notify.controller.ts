import { Controller, Logger, Optional, Post, RawBodyRequest, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { RateLimit } from '../common/rate-limit.guard';
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

    /*
   * 阈值刻意取得很高（10 次/秒/来源 IP）。
   *
   * 这是**支付回调**，误伤等于钱不落账。取值原则是「绝不可能碰到正常流量」：
   * 微信回调来自少量固定服务器 IP，即使 1600 户集中缴费也远达不到单 IP 每秒 10 次；
   * 而攻击者的 TCP 源 IP 无法伪造，会落进自己的桶里，所以高阈值仍能挡住
   * 「反复发垃圾包消耗 RSA 验签 CPU」这一条 —— 验签在业务处理之前，不限流就是白送 CPU。
   *
   * 万一真误伤：微信在 24 小时内按退避重试，且对账任务会补齐漏掉的支付，
   * 有两层兜底。但兜底不是放松阈值的理由，阈值本身必须足够宽。
   */
  @RateLimit({ limit: 600, windowMs: 60_000 })
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
