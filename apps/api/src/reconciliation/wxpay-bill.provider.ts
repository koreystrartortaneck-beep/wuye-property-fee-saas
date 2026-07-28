import { Injectable } from '@nestjs/common';
import { ReconciliationBillType } from '@pf/shared';
import { WxPayDirectProvider } from '../payment/wxpay-direct.provider';
import {
  ChannelBill,
  DownloadBillInput,
  WechatBillProvider,
  hashBill,
  parseRefundBillCsv,
  parseTradeBillCsv,
} from './wechat-bill.provider';

/**
 * 真实的微信支付对账单渠道。
 *
 * 为什么必须有这个文件：在它之前，ReconciliationModule 无条件把
 * WECHAT_BILL_PROVIDER 绑到 MockWechatBillProvider，而 Mock 永远返回空账期。
 * 于是生产环境每天两次对账都是：渠道 0 笔、本地 N 笔、把 N 笔全部登记成
 * CHANNEL_MISSING 差异，批次状态还写 COMPLETED。
 *
 * 后果是双向的：
 *   - 真实资金风险（微信扣款成功而本地未记账、金额不一致）永远发现不了；
 *   - 同时持续产出假差异，把差异计数撑起来，真差异反而被埋掉。
 *
 * 线上实测特征（生产库 10 次对账全部如此）：channelRecordCount 恒为 0、
 * channelFileHash 恒为 SHA256("[]")=4f53cda1…、单次耗时 15–34ms
 * （根本来不及发起一次网络请求）。
 */
@Injectable()
export class WxPayBillProvider implements WechatBillProvider {
  constructor(private readonly wxpay: WxPayDirectProvider) {}

  async downloadBill(input: DownloadBillInput): Promise<ChannelBill> {
    const billType: ReconciliationBillType = input.billType;
    const csv = await this.wxpay.downloadBillCsv(
      billType === 'REFUND' ? 'REFUND' : 'TRANSACTION',
      input.businessDate,
    );

    const trades = billType === 'REFUND' ? [] : parseTradeBillCsv(csv);
    const refunds = billType === 'REFUND' ? parseRefundBillCsv(csv) : [];
    const list = billType === 'REFUND' ? refunds : trades;
    const totalAmountCents =
      billType === 'REFUND'
        ? refunds.reduce((sum, r) => sum + r.refundCents, 0)
        : trades.reduce((sum, t) => sum + t.amountCents, 0);

    return {
      billType,
      businessDate: input.businessDate,
      // 对原始文件内容取哈希（而非解析结果），便于事后核对拿到的就是那一份账单
      fileHash: hashBill(csv),
      recordCount: list.length,
      totalAmountCents,
      trades,
      refunds,
    };
  }
}
