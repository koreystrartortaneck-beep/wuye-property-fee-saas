import { Injectable, Logger } from '@nestjs/common';
import { CreateOrderInput, PaymentProvider } from './provider';

/**
 * Mock 支付渠道（PAY_MODE=mock）。
 * createOrder 返回模拟支付参数；前端随后调用 mock-confirm 完成支付。
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  private readonly logger = new Logger('MockPay');

  async createOrder(input: CreateOrderInput): Promise<Record<string, unknown>> {
    this.logger.log(`[mock 下单] ${input.orderNo} ¥${(input.totalCents / 100).toFixed(2)}`);
    return {
      mock: true,
      orderNo: input.orderNo,
      confirmUrl: `/api/v1/owner/payments/${input.orderNo}/mock-confirm`,
    };
  }

  async close(orderNo: string): Promise<void> {
    this.logger.log(`[mock 关单] ${orderNo}`);
  }
}
