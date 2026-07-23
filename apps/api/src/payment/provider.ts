/** 支付渠道抽象：默认 Mock，可通过 PAY_MODE=wxpay 切换普通商户 API v3。 */

export interface CreateOrderInput {
  orderNo: string;
  totalCents: number;
  description: string;
  payerOpenid: string;
  tenantId: string;
}

export interface WxPayTransaction {
  appid: string;
  mchid: string;
  out_trade_no: string;
  transaction_id: string;
  trade_state: string;
  trade_state_desc?: string;
  success_time?: string;
  attach?: string;
  amount: {
    total: number;
    payer_total?: number;
    currency?: string;
    payer_currency?: string;
  };
}

export interface CreateRefundInput {
  /** 商户订单号（原支付单） */
  outTradeNo: string;
  /** 微信支付交易号（有则优先使用） */
  transactionId?: string;
  /** 稳定的商户退款单号（供中断恢复复用） */
  outRefundNo: string;
  /** 原订单总额（分） */
  totalCents: number;
  /** 退款金额（分，全额退款等于 totalCents） */
  refundCents: number;
  reason: string;
  tenantId: string;
}

export interface WxPayRefund {
  refund_id: string;
  out_refund_no: string;
  out_trade_no?: string;
  transaction_id?: string;
  /** 退款状态：SUCCESS | CLOSED | PROCESSING | ABNORMAL */
  status: string;
  channel?: string;
  success_time?: string;
  amount: {
    total: number;
    refund: number;
    payer_total?: number;
    payer_refund?: number;
    currency?: string;
  };
}

export class PaymentProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

export interface PaymentProvider {
  /** 创建渠道订单，返回小程序端拉起支付所需参数 */
  createOrder(input: CreateOrderInput): Promise<Record<string, unknown>>;
  /** 查询渠道订单；Mock 渠道无需实现 */
  queryOrder?(orderNo: string): Promise<WxPayTransaction>;
  /** 关闭渠道订单 */
  close(orderNo: string): Promise<void>;
  /** 申请退款；Mock 渠道无需实现 */
  createRefund?(input: CreateRefundInput): Promise<WxPayRefund>;
  /** 查询退款；Mock 渠道无需实现 */
  queryRefund?(outRefundNo: string): Promise<WxPayRefund>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
