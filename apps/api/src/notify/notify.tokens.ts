import { Bill } from '@prisma/client';

export type ReminderType = 'DUE_SOON' | 'OVERDUE';

/** 账单事件通知接口：通知模块提供真实实现，出账/调度只依赖此抽象 */
export interface BillNotifier {
  onBillCreated(bill: Bill): Promise<void>;
  /** 到期前/逾期提醒；实现方负责按 (bill,type) 去重 */
  onReminder(bill: Bill, type: ReminderType): Promise<void>;
}

export const BILL_NOTIFIER = Symbol('BILL_NOTIFIER');

/** Outbox 事件投递结果：已投递 / 无需投递（无模板或未订阅）/ 可重试。 */
export type OutboxDeliveryOutcome = 'DELIVERED' | 'SKIPPED' | 'RETRY';

/** 投递适配器所需的最小 Outbox 事件字段（订阅消息通道可替换）。 */
export interface DeliverableOutboxEvent {
  id: string;
  tenantId: string;
  aggregateType: string;
  eventType: string;
  payload: unknown;
  claimOwner?: string | null;
  claimExpiresAt?: Date | null;
}

/** 默认空实现（通知模块接入前使用） */
export class NoopBillNotifier implements BillNotifier {
  async onBillCreated(): Promise<void> {
    /* noop */
  }

  async onReminder(): Promise<void> {
    /* noop */
  }
}
