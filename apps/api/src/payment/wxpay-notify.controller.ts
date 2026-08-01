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
    /*
     * 验签与业务处理分成两段 try，因为两者的可观测性完全不同：
     *
     *   · 验签失败 → 拿不到订单号，只能发告警
     *   · 验签通过、业务处理失败 → **知道是哪一笔**，必须在这笔订单上留下持久痕迹
     *
     * 原来两段合在一起，后者也只发一条按小时去重的全局告警，
     * 且告警在 WX_PAY_ALLOWED_TENANT_ID 缺失时会静默 return。
     * 2026-08-01 事故里我因此先误判成「回调从未到达」——
     * 实际是回调到了、验签过了、入账那步被并发静默跳过，而这件事没有任何记录。
     *
     * 另外原来无论哪种失败都回「签名验证失败」，日志与响应互相矛盾，
     * 排查时会把人往验签方向带。
     */
    let transaction;
    try {
      if (!req.rawBody) throw new Error('支付回调缺少原始请求体');
      transaction = this.wxPay.parseNotification(req.headers, req.rawBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`微信支付回调验签失败：${message}`);
      await emitCallbackRejectedAlert(this.alerts, 'PAYMENT_CALLBACK_REJECTED', '微信支付回调验签失败', message);
      res.status(401).json({ code: 'FAIL', message: '签名验证失败' });
      return;
    }

    try {
      await this.paymentService.handleWxPayNotification(transaction);
      res.status(200).json({ code: 'SUCCESS', message: '成功' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`微信支付回调处理失败 order=${transaction.out_trade_no}：${message}`);
      // 落到这笔订单上，「入账溯源」的时间线里能直接看到
      await this.paymentService.recordNotifyFailure(
        transaction.out_trade_no,
        transaction.transaction_id ?? null,
        message,
      );
      await emitCallbackRejectedAlert(
        this.alerts,
        'PAYMENT_CALLBACK_REJECTED',
        '微信支付回调处理失败',
        `order=${transaction.out_trade_no} ${message}`,
      );
      /*
       * 必须回非 2xx：微信只在非 2xx 时按退避重试，而重试是这笔钱能自己回来的
       * 主要途径。回 200 就等于告诉微信「已受理」，它永不再来。
       */
      res.status(500).json({ code: 'FAIL', message: '回调处理失败，请重试' });
    }
  }
}
