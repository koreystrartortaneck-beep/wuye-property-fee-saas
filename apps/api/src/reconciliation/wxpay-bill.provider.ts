import { Injectable, Logger } from '@nestjs/common';
import { ReconciliationBillType } from '@pf/shared';
import { PaymentProviderError } from '../payment/provider';
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

  private readonly logger = new Logger(WxPayBillProvider.name);

  async downloadBill(input: DownloadBillInput): Promise<ChannelBill> {
    const billType: ReconciliationBillType = input.billType;

    let csv: string;
    try {
      csv = await this.wxpay.downloadBillCsv(
        billType === 'REFUND' ? 'REFUND' : 'TRANSACTION',
        input.businessDate,
      );
    } catch (error) {
      /*
       * NO_STATEMENT_EXIST 是微信给出的**明确答复**：那一天没有账单文件，
       * 也就是当天没有任何交易。这不是故障，必须按「空账期」正常完成对账。
       *
       * 线上实测：07-22 REFUND、07-25、07-26 四个零交易账期全部被判为 FAILED，
       * 管理端拿到 500。物业公司大多数日子本来就没有交易，若不区分，等于每天
       * 对账都失败、每天都告警，真故障反而被淹没。
       *
       * 其余错误一律继续抛出——绝不能把「下载失败」当成「当天没交易」，
       * 那样又会把本地全部交易误判为「微信侧缺失」。
       */
      if (error instanceof PaymentProviderError && error.code === 'NO_STATEMENT_EXIST') {
        this.logger.log(
          `账期 ${input.businessDate} ${billType} 微信侧无账单文件（当天无交易），按空账期处理`,
        );
        return {
          billType,
          businessDate: input.businessDate,
          fileHash: '',
          recordCount: 0,
          totalAmountCents: 0,
          trades: [],
          refunds: [],
        };
      }
      throw error;
    }

    /*
     * 交易账单用 bill_type=ALL 拉取，保证「当天付过款的订单」一个不漏（含当日又
     * 退了款的）。代价是同一笔订单会出现两行：一行 交易状态=SUCCESS，一行
     * =REFUND 且应结金额为 0。
     *
     * 线上实测：07-24 本地 2 笔、渠道 4 行，多出的两行 REFUND 被判成
     * AMOUNT_MISMATCH（渠道金额 0 vs 本地 2.50）——纯属虚报。退款本来就由
     * REFUND 账单单独对账，所以这里只保留成功付款那一行。
     */
    const allTrades = billType === 'REFUND' ? [] : parseTradeBillCsv(csv);
    const trades = allTrades.filter((t) => t.tradeState === 'SUCCESS');
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
