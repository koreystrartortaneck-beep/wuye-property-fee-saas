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

/**
 * 上海账期（YYYY-MM-DD）对应的 UTC 时间半开区间 [start, end)。
 *
 * 用来把日期过滤下推到 SQL。原实现是把该租户**全部**历史微信支付拉进内存，
 * 再用 shanghaiBillingDate 逐行比对账期：
 *   3000 户、缴费率 90%、每月 1 笔 → 第一年 32400 行、第三年 97200 行
 *   每天 10:30 的对账把这 97200 行全部读出来，只为用其中当日约 90 行（有效率 0.09%）
 * 而且 localTotals 会**再查一遍**同一份数据，runDaily 又对 TRANSACTION 与 REFUND
 * 两种类型各跑一次，合计 4 次全表扫。
 *
 * 上海固定 +8 且无夏令时，所以直接按 -8 小时换算即可，不需要 Intl。
 */
export function shanghaiDayRangeUtc(businessDate: string): { start: Date; end: Date } {
  const [y, m, d] = businessDate.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`账期格式非法：${businessDate}`);
  // 该日上海 00:00:00 == UTC 前一日 16:00:00
  const start = new Date(Date.UTC(y, m - 1, d, -8, 0, 0, 0));
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

function centsFromYuan(yuan: string): number {
  return Math.round(Number(yuan) * 100);
}

/**
 * 截掉微信对账单末尾的汇总段。
 *
 * 真实账单结构是「明细表头 + 明细行 + 汇总表头 + 汇总行」，汇总段用的是另一套
 * 列名（总交易单数,总交易额,总退款金额,…），列数与明细段也不同。
 *
 * 原实现只判断 `row['商户订单号'] === '总交易单数'`，但用 columns:true 解析时
 * 汇总段是按**明细表头**映射的，'总交易单数' 会落到「交易时间」那一列上，
 * 商户订单号列拿到的是 '申请退款总金额' 之类，判断永远不成立。
 *
 * 线上后果（接入真实下载后第一次对账就暴露）：2026-07-22 的账单实际只有 1 笔
 * 交易，却解析出 3 条「渠道记录」，多出来的两条订单号分别是 `0.00` 和
 * `申请退款总金额`，被登记成 LOCAL_MISSING 假差异。这个 bug 一直没被发现，
 * 正是因为账单渠道此前是 Mock、永远返回空账期，解析函数从没喂过真实账单。
 *
 * 这里在**文本层**按行截断（汇总段起始行的第一个字段是「总交易单数」），
 * 再交给 CSV 解析器，从根上避免列错位。
 */
function stripSummarySection(csv: string): string {
  const lines = csv.split(/\r?\n/);
  const end = lines.findIndex((line) => {
    const firstField = strip((line.split(',')[0] ?? '').trim());
    return firstField === '总交易单数' || firstField === '总退款单数';
  });
  return (end === -1 ? lines : lines.slice(0, end)).join('\n');
}

/**
 * 微信对账单 CSV 解析（结构化解析，禁用 split(',')）。
 * 交易账单每行以 `` ` `` 前缀防注入；此处按微信标准列解析必要字段，不落敏感明文。
 */
export function parseTradeBillCsv(csv: string): ChannelTradeRecord[] {
  const rows = parseCsv(stripSummarySection(csv), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Record<string, string>[];
  const records: ChannelTradeRecord[] = [];
  for (const row of rows) {
    const outTradeNo = strip(row['商户订单号'] ?? row['outTradeNo']);
    if (!outTradeNo) continue;
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
  const rows = parseCsv(stripSummarySection(csv), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Record<string, string>[];
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
