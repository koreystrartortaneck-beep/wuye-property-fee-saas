import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RulePeriod } from '@pf/shared';
import { BILL_NOTIFIER, BillNotifier, NoopBillNotifier } from '../notify/notify.tokens';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';
import { BillRunService } from './bill-run.service';
import { currentPeriod } from './period';

/**
 * 定时任务（spec §6.3）：
 * - 每日 02:00 自动出账：billDay 命中 + 周期锚点命中的启用规则
 * - 每日 09:00 催缴扫描：到期前 3 天 DUE_SOON、已逾期 OVERDUE
 * 单条规则/账单异常只记日志，不阻断其余。
 */
@Injectable()
export class ScheduleService {
  private readonly logger = new Logger('Schedule');

  constructor(
    private readonly prisma: PrismaService,
    private readonly billRun: BillRunService,
    @Optional() @Inject(BILL_NOTIFIER) private readonly notifier: BillNotifier = new NoopBillNotifier(),
  ) {}

  @Cron('0 0 2 * * *')
  async runDailyBilling(now: Date = new Date()): Promise<void> {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { status: 'ACTIVE' } });
    for (const tenant of tenants) {
      await runWithTenant(tenant.id, async () => {
        const rules = await this.prisma.t.feeRule.findMany({
          where: { enabled: true, billDay: now.getDate() },
        });
        for (const rule of rules) {
          const period = currentPeriod(now, rule.period as RulePeriod);
          if (!period) continue;
          try {
            await this.billRun.generate(rule.id, period);
          } catch (e) {
            this.logger.error(`出账失败 rule=${rule.id} period=${period}: ${e instanceof Error ? e.message : e}`);
          }
        }
      });
    }
  }

  @Cron('0 0 9 * * *')
  async runReminders(now: Date = new Date()): Promise<void> {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { status: 'ACTIVE' } });
    for (const tenant of tenants) {
      await runWithTenant(tenant.id, async () => {
        // 到期前 3 天（那一天 00:00 ~ 23:59:59）
        const target = new Date(now);
        target.setDate(target.getDate() + 3);
        const dayStart = new Date(target.getFullYear(), target.getMonth(), target.getDate());
        const dayEnd = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 23, 59, 59);

        const dueSoon = await this.prisma.t.bill.findMany({
          where: { status: 'UNPAID', dueDate: { gte: dayStart, lte: dayEnd } },
        });
        for (const bill of dueSoon) {
          try {
            await this.notifier.onReminder(bill as never, 'DUE_SOON');
          } catch (e) {
            this.logger.warn(`到期提醒失败 bill=${bill.id}: ${e instanceof Error ? e.message : e}`);
          }
        }

        const overdue = await this.prisma.t.bill.findMany({
          where: { status: 'UNPAID', dueDate: { lt: now } },
        });
        for (const bill of overdue) {
          try {
            await this.notifier.onReminder(bill as never, 'OVERDUE');
          } catch (e) {
            this.logger.warn(`逾期提醒失败 bill=${bill.id}: ${e instanceof Error ? e.message : e}`);
          }
        }
      });
    }
  }
}
