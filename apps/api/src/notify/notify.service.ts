import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bill } from '@prisma/client';
import { NotifyType } from '@pf/shared';
import { PrismaService } from '../prisma/prisma.service';
import { WX_API, WxApi } from '../wx/wx.service';
import { BillNotifier, ReminderType } from './notify.tokens';

/**
 * 账单通知服务（spec §6.3 / §10）。
 * - 找账单房屋的全部 ACTIVE 绑定用户逐一推送，写 NotifyLog
 * - 无绑定用户 → 记一条 SKIPPED（不阻塞出账）
 * - 提醒类按 (billId, type, SENT) 去重：每张账单每类提醒最多一次
 * - 显式使用 bill.tenantId 写日志（调用方上下文可能是调度器）
 */
@Injectable()
export class NotifyService implements BillNotifier {
  private readonly logger = new Logger('Notify');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WX_API) private readonly wx: WxApi,
  ) {}

  async onBillCreated(bill: Bill): Promise<void> {
    await this.send('BILL_CREATED', bill, false);
  }

  async onReminder(bill: Bill, type: ReminderType): Promise<void> {
    await this.send(type, bill, true);
  }

  private async send(type: NotifyType, bill: Bill, dedup: boolean): Promise<void> {
    if (dedup) {
      const sent = await this.prisma.raw.notifyLog.findFirst({
        where: { billId: bill.id, type, status: 'SENT' },
      });
      if (sent) return;
    }

    const bindings = await this.prisma.raw.houseBinding.findMany({
      where: { houseId: bill.houseId, status: 'ACTIVE' },
      include: { wxUser: { select: { id: true, openid: true } } },
    });

    if (bindings.length === 0) {
      await this.prisma.raw.notifyLog.create({
        data: { tenantId: bill.tenantId, billId: bill.id, type, channel: 'MOCK', status: 'SKIPPED', error: '房屋无绑定用户' },
      });
      return;
    }

    for (const binding of bindings) {
      const result = await this.wx
        .sendSubscribeMessage({
          openid: binding.wxUser.openid,
          templateType: type,
          data: {
            title: bill.title,
            amount: bill.amount.toString(),
            period: bill.period,
            dueDate: bill.dueDate.toISOString().slice(0, 10),
          },
        })
        .catch((e: Error) => ({ ok: false, error: e.message }));

      await this.prisma.raw.notifyLog.create({
        data: {
          tenantId: bill.tenantId,
          wxUserId: binding.wxUser.id,
          billId: bill.id,
          type,
          channel: process.env.WX_MODE === 'real' ? 'WX_SUBSCRIBE' : 'MOCK',
          status: result.ok ? 'SENT' : 'FAILED',
          error: result.ok ? null : (result as { error?: string }).error,
        },
      });
    }
    this.logger.log(`通知 ${type} bill=${bill.id} 推送 ${bindings.length} 人`);
  }
}
