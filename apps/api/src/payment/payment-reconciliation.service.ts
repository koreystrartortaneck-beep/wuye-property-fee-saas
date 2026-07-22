import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentService } from './payment.service';

@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
  ) {}

  @Cron('0 */10 * * * *')
  async closeStaleOrders(now: Date = new Date()): Promise<void> {
    if (process.env.PAY_MODE !== 'wxpay') return;
    const cutoff = new Date(now.getTime() - 30 * 60 * 1000);
    const stale = await this.prisma.raw.payment.findMany({
      where: { channel: 'WXPAY', status: 'CREATED', createdAt: { lt: cutoff } },
      select: { orderNo: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    for (const payment of stale) {
      try {
        await this.payments.reconcileStaleWxPay(payment.orderNo);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`微信支付订单对账失败 order=${payment.orderNo}: ${message}`);
      }
    }
  }

}
