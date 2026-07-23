import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ReconciliationBillType } from '@pf/shared';
import { parse as parseCsv } from 'csv-parse/sync';

export interface ChannelTradeRecord {
  outTradeNo: string;
  transactionId: string;
  tradeState: string;
  amountCents: number;
}

export interface ChannelRefundRecord {
  outTradeNo: string;
  outRefundNo: string;
  refundState: string;
  refundCents: number;
}

export interface ChannelBill {
  billType: ReconciliationBillType;
  businessDate: string; // YYYY-MM-DD（上海账期）
  fileHash: string;
  recordCount: number;
  totalAmountCents: number;
  trades: ChannelTradeRecord[];
  refunds: ChannelRefundRecord[];
}

export interface DownloadBillInput {
  merchantAccountId: string;
  mchid: string;
  appid: string;
  businessDate: string;
  billType: ReconciliationBillType;
}

export interface WechatBillProvider {
  /** 下载并校验对账单；不可用（账期未生成）时抛错以便重试。 */
  downloadBill(input: DownloadBillInput): Promise<ChannelBill>;
}

export const WECHAT_BILL_PROVIDER = Symbol('WECHAT_BILL_PROVIDER');

/** 上海时区账期日 YYYY-MM-DD（对账单以自然日切分）。 */
export function shanghaiBillingDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function centsFromYuan(yuan: string): number {
  return Math.round(Number(yuan) * 100);
}

/**
 * 微信对账单 CSV 解析（结构化解析，禁用 split(',')）。
 * 交易账单每行以 `` ` `` 前缀防注入；此处按微信标准列解析必要字段，不落敏感明文。
 */
export function parseTradeBillCsv(csv: string): ChannelTradeRecord[] {
  const rows = parseCsv(csv, { columns: true, skip_empty_lines: true, relax_column_count: true }) as Record<string, string>[];
  const records: ChannelTradeRecord[] = [];
  for (const row of rows) {
    const outTradeNo = strip(row['商户订单号'] ?? row['outTradeNo']);
    if (!outTradeNo || outTradeNo === '总交易单数') break; // 汇总行
    records.push({
      outTradeNo,
      transactionId: strip(row['微信支付订单号'] ?? row['transactionId'] ?? ''),
      tradeState: strip(row['交易状态'] ?? row['tradeState'] ?? 'SUCCESS'),
      amountCents: centsFromYuan(strip(row['应结订单金额'] ?? row['总金额'] ?? row['amount'] ?? '0')),
    });
  }
  return records;
}

export function parseRefundBillCsv(csv: string): ChannelRefundRecord[] {
  const rows = parseCsv(csv, { columns: true, skip_empty_lines: true, relax_column_count: true }) as Record<string, string>[];
  const records: ChannelRefundRecord[] = [];
  for (const row of rows) {
    const outTradeNo = strip(row['商户订单号'] ?? row['outTradeNo']);
    const outRefundNo = strip(row['商户退款单号'] ?? row['outRefundNo']);
    if (!outRefundNo) continue;
    records.push({
      outTradeNo,
      outRefundNo,
      refundState: strip(row['退款状态'] ?? row['refundState'] ?? 'SUCCESS'),
      refundCents: centsFromYuan(strip(row['退款金额'] ?? row['refundAmount'] ?? '0')),
    });
  }
  return records;
}

function strip(value: string | undefined): string {
  return (value ?? '').replace(/^`/, '').trim();
}

export function hashBill(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Mock 对账单渠道（PAY_MODE!=wxpay / 测试）：默认返回空账期。
 * 真实微信对账单下载在生产 wxpay 模式下由独立适配器实现（带签名/校验/gzip/CSV）。
 */
@Injectable()
export class MockWechatBillProvider implements WechatBillProvider {
  private nextBill: Partial<ChannelBill> | null = null;

  /** 测试注入下一次下载返回的渠道数据。 */
  setNextBill(bill: Partial<ChannelBill>): void {
    this.nextBill = bill;
  }

  async downloadBill(input: DownloadBillInput): Promise<ChannelBill> {
    const trades = this.nextBill?.trades ?? [];
    const refunds = this.nextBill?.refunds ?? [];
    const list = input.billType === 'REFUND' ? refunds : trades;
    const totalAmountCents =
      input.billType === 'REFUND'
        ? refunds.reduce((s, r) => s + r.refundCents, 0)
        : trades.reduce((s, t) => s + t.amountCents, 0);
    this.nextBill = null;
    return {
      billType: input.billType,
      businessDate: input.businessDate,
      fileHash: hashBill(JSON.stringify(list)),
      recordCount: list.length,
      totalAmountCents,
      trades,
      refunds,
    };
  }
}
