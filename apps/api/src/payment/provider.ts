/** 支付渠道抽象（spec §6.4）：Mock 本期实现，微信服务商模式子项目 5 接入 */

export interface CreateOrderInput {
  orderNo: string;
  totalCents: number;
  description: string;
  payerOpenid: string;
  tenantId: string;
}

export interface PaymentProvider {
  /** 创建渠道订单，返回小程序端拉起支付所需参数 */
  createOrder(input: CreateOrderInput): Promise<Record<string, unknown>>;
  /** 关闭渠道订单 */
  close(orderNo: string): Promise<void>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
