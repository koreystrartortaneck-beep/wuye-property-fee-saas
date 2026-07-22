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
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
