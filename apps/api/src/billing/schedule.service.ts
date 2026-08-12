import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RulePeriod } from '@pf/shared';
import { BILL_NOTIFIER, BillNotifier, NoopBillNotifier } from '../notify/notify.tokens';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';
import { BillRunService } from './bill-run.service';
import { currentPeriod } from './period';

/** 运行时记录的保留天数。财务凭证与审计留痕不在清理范围内。 */
const PURGE_RETAIN_DAYS = 90;

/**
 * 定时任务（spec §6.3）：
 * - 每日 02:00 自动出账：billDay 命中 + 周期锚点命中的启用规则
 * - 每日 04:00 清理过期的幂等记录与已投递的历史事件/通知日志
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

  /**
   * 每日 04:00 清理不再需要的运行时记录。
   *
   * 全库此前**没有任何清理任务**（grep '@Cron' 只有 6 个，deleteMany 只有对账重跑
   * 那一处）。而 IdempotencyRecord 有 expiresAt 字段和 @@index([expiresAt])——
   * 索引建了、字段写了，却从来没有代码用它删过过期记录，说明设计意图明确但实现缺失。
   *
   * 按 3000 户估算的年增量：
   *   IdempotencyRecord  约 4 万行（每笔支付/发布/作废/催缴一条，含 responseBody Json）
   *   OutboxEvent        约 18 万行（出账 1.2 万/月 + 催缴，PUBLISHED 后永久保留，含 payload）
   *   NotifyLog          约 13 万行（3000 户 × 3 类提醒 × 1.2 人/月）
   *   PaymentEvent       约 15 万行（每笔支付 4-6 个事件）
   * 不会立刻出问题，但让每次 count()、每次索引维护、每次备份都变重。
   *
   * 刻意**不清**的：AuditLog（审计留痕，且 DB 层有 append-only 触发器）、
   * Payment / Refund / Bill / InvoiceApplication（财务凭证）。
   * 只清「运行时中间态」——过期的幂等键、已投递完的事件、历史通知日志。
   */
  @Cron('0 0 4 * * *')
  async purgeExpired(now: Date = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - PURGE_RETAIN_DAYS * 86_400_000);
    try {
      // 用上已有的 @@index([expiresAt])
      const idem = await this.prisma.raw.idempotencyRecord.deleteMany({
        where: { expiresAt: { lt: now } },
      });
      // 只删已成功投递的：PENDING/FAILED 还要重试，PROCESSING 可能正被别的实例持有
      const outbox = await this.prisma.raw.outboxEvent.deleteMany({
        where: { status: 'PUBLISHED', publishedAt: { lt: cutoff } },
      });
      const notify = await this.prisma.raw.notifyLog.deleteMany({
        where: { sentAt: { lt: cutoff } },
      });
      this.logger.log(
        `清理完成：幂等 ${idem.count} 条、已投递事件 ${outbox.count} 条、通知日志 ${notify.count} 条` +
          `（保留最近 ${PURGE_RETAIN_DAYS} 天）`,
      );
    } catch (e) {
      // 清理失败不影响业务，下一轮再来
      this.logger.warn(`清理任务失败：${e instanceof Error ? e.message : e}`);
    }
  }

  /** 周年草稿的提前量:周年日前 7 天自动出草稿(2026-08-11 用户定) */
  static readonly ANNIVERSARY_ADVANCE_DAYS = 7;

  @Cron('0 0 2 * * *')
  async runDailyBilling(now: Date = new Date()): Promise<void> {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { status: 'ACTIVE' } });
    for (const tenant of tenants) {
      await runWithTenant(tenant.id, async () => {
        const rules = await this.prisma.t.feeRule.findMany({ where: { enabled: true } });
        for (const rule of rules) {
          /*
           * 周年方案(2026-08-11 改):**每天**扫,窗口 = [今天, 今天+7天]。
           * 之前只在 billDay(每月 1 号)扫当月一次,两个真窟窿:
           *   ① 提前量不固定 —— 1 号周年的户 0 天,31 号的 30 天;
           *   ② 错过就永远错过 —— 8 月 2 号导入的房,8 月 1 号那班车已开走,
           *      当月 15 户就是这么漏的(手工补的)。
           * 现在:每户在周年日前 7 天准时出草稿;当月已过周年没账单的也捞回来;
           * 月底最后几天窗口跨月,把下月初的户一起扫到。
           * 只生成草稿(业主不可见),发布仍是物业过目后手动 —— 自动化的是准备,不是决定。
           * legacy 三种周期照旧:billDay 当天、currentPeriod(锚点月为 null 时跳过)。
           */
          if (rule.periodScheme === 'ANNIVERSARY') {
            const horizon = new Date(now);
            horizon.setDate(horizon.getDate() + ScheduleService.ANNIVERSARY_ADVANCE_DAYS);
            const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            const periods = [...new Set([ym(now), ym(horizon)])];
            for (const period of periods) {
              try {
                await this.billRun.generate(rule.id, period, {
                  anniversaryUpTo: horizon,
                  // 物业月中发布过主批次后,月内后续到周年的户进补充批次,不能被「已发布」堵死
                  supplementOnPublished: true,
                });
              } catch (e) {
                this.logger.error(`出账失败 rule=${rule.id} period=${period}: ${e instanceof Error ? e.message : e}`);
              }
            }
            continue;
          }
          if (rule.billDay !== now.getDate()) continue;
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
            await this.notifier.onReminder(bill, 'DUE_SOON');
          } catch (e) {
            this.logger.warn(`到期提醒失败 bill=${bill.id}: ${e instanceof Error ? e.message : e}`);
          }
        }

        const overdue = await this.prisma.t.bill.findMany({
          where: { status: 'UNPAID', dueDate: { lt: now } },
        });
        for (const bill of overdue) {
          try {
            await this.notifier.onReminder(bill, 'OVERDUE');
          } catch (e) {
            this.logger.warn(`逾期提醒失败 bill=${bill.id}: ${e instanceof Error ? e.message : e}`);
          }
        }
      });
    }
  }
}
