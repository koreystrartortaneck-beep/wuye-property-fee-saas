import { Bill } from '@prisma/client';

/** 账单事件通知接口：T14 提供真实实现，出账服务只依赖此抽象 */
export interface BillNotifier {
  onBillCreated(bill: Bill): Promise<void>;
}

export const BILL_NOTIFIER = Symbol('BILL_NOTIFIER');

/** 默认空实现（通知模块接入前使用） */
export class NoopBillNotifier implements BillNotifier {
  async onBillCreated(): Promise<void> {
    /* noop */
  }
}
