import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { request as httpsRequest } from 'node:https';
import { redactAndTruncateText, redactSensitive } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { IncidentService, IncidentSeverity } from './incident.service';

export const ALERT_DISPATCHER = Symbol('ALERT_DISPATCHER');

export interface AlertDeliveryPayload {
  alertType: string;
  severity: string;
  tenantId: string;
  communityId: string | null;
  title: string;
  summary: string | null;
  context: unknown;
  occurrences: number;
}

export interface AlertDeliveryResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

export interface AlertDispatcher {
  configured(): boolean;
  deliver(payload: AlertDeliveryPayload): Promise<AlertDeliveryResult>;
}

/** 默认 HTTPS Webhook 投递器：POST 到 OPS_ALERT_WEBHOOK（仅允许 https）。适配器可替换。 */
@Injectable()
export class WebhookAlertDispatcher implements AlertDispatcher {
  private readonly logger = new Logger('AlertDispatcher');

  private get url(): string {
    return process.env.OPS_ALERT_WEBHOOK || '';
  }

  configured(): boolean {
    return this.url.startsWith('https://');
  }

  deliver(payload: AlertDeliveryPayload): Promise<AlertDeliveryResult> {
    if (!this.configured()) {
      return Promise.resolve({ ok: false, error: '告警目的地未配置' });
    }
    const body = JSON.stringify(payload);
    return new Promise((resolve) => {
      try {
        const req = httpsRequest(
          this.url,
          { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 8000 },
          (res) => {
            res.resume();
            const code = res.statusCode ?? 0;
            resolve({ ok: code >= 200 && code < 300, statusCode: code });
          },
        );
        req.on('timeout', () => req.destroy(new Error('告警投递超时')));
        req.on('error', (err) => resolve({ ok: false, error: err.message }));
        req.write(body);
        req.end();
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }
}

export interface EmitAlertInput {
  tenantId: string;
  communityId?: string | null;
  alertType: string;
  severity: IncidentSeverity;
  dedupKey: string;
  title: string;
  summary?: string | null;
  context?: unknown;
}

export interface EmitAlertResult {
  alertId: string;
  deduped: boolean;
  delivered: boolean;
  incidentId: string | null;
}

/**
 * 运营告警：支付/退款回调拒绝、恢复耗尽、对账差异、定时任务失败等触发去重告警，
 * 严重告警映射到事件；投递尝试持久化（重启后可续投/重试）；投递前脱敏，绝不含
 * 手机号/令牌/私钥/APIv3 密钥/回调原文。
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger('AlertService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly incidents: IncidentService,
    @Optional() @Inject(ALERT_DISPATCHER) private readonly dispatcher: AlertDispatcher | null = null,
  ) {}

  readiness(): { healthy: boolean; destinationConfigured: boolean } {
    const configured = !!this.dispatcher && this.dispatcher.configured();
    return { healthy: configured, destinationConfigured: configured };
  }

  async emit(input: EmitAlertInput): Promise<EmitAlertResult> {
    const summary = input.summary ? redactAndTruncateText(input.summary, 1000) : null;
    const context = input.context === undefined ? undefined : redactSensitive(input.context);

    const existing = await this.prisma.raw.operationalAlert.findUnique({
      where: { tenantId_dedupKey: { tenantId: input.tenantId, dedupKey: input.dedupKey } },
    });

    let alertId: string;
    let attemptNo: number;
    let occurrences: number;
    const deduped = !!existing;

    if (existing) {
      occurrences = (existing.occurrences || 1) + 1;
      attemptNo = occurrences;
      alertId = existing.id;
      await this.prisma.raw.operationalAlert.update({
        where: { tenantId_id: { tenantId: input.tenantId, id: existing.id } },
        data: { occurrences: { increment: 1 }, lastSeenAt: new Date() },
      });
    } else {
      occurrences = 1;
      attemptNo = 1;
      const created = await this.prisma.raw.operationalAlert.create({
        data: {
          tenantId: input.tenantId,
          communityId: input.communityId ?? null,
          alertType: input.alertType,
          severity: input.severity,
          dedupKey: input.dedupKey,
          title: input.title,
          summary,
          context: context === undefined ? undefined : (context as object),
          status: 'OPEN',
          occurrences: 1,
        },
      });
      alertId = created.id;
    }

    let incidentId: string | null = null;
    if (input.severity === 'CRITICAL') {
      const incident = await this.incidents.openOrReopen({
        tenantId: input.tenantId,
        communityId: input.communityId ?? null,
        dedupKey: input.dedupKey,
        title: input.title,
        severity: input.severity,
      });
      incidentId = incident.id;
      await this.prisma.raw.operationalAlert
        .update({ where: { tenantId_id: { tenantId: input.tenantId, id: alertId } }, data: { incidentId } })
        .catch(() => undefined);
    }

    const payload: AlertDeliveryPayload = {
      alertType: input.alertType,
      severity: input.severity,
      tenantId: input.tenantId,
      communityId: input.communityId ?? null,
      title: input.title,
      summary,
      context: context ?? null,
      occurrences,
    };

    let delivered = false;
    let statusCode: number | undefined;
    let error: string | null = null;
    if (this.dispatcher && this.dispatcher.configured()) {
      const result: AlertDeliveryResult = await this.dispatcher.deliver(payload).catch((e: unknown) => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }));
      delivered = result.ok;
      statusCode = result.statusCode;
      error = result.error ? redactAndTruncateText(result.error) : null;
    } else {
      error = '告警目的地未配置';
    }

    await this.prisma.raw.alertAttempt.create({
      data: {
        tenantId: input.tenantId,
        alertId,
        attemptNo,
        channel: 'WEBHOOK',
        success: delivered,
        statusCode: statusCode ?? null,
        error,
      },
    });

    await this.prisma.raw.operationalAlert
      .update({
        where: { tenantId_id: { tenantId: input.tenantId, id: alertId } },
        data: { status: delivered ? 'DELIVERED' : 'FAILED', deliveredAt: delivered ? new Date() : null },
      })
      .catch(() => undefined);

    return { alertId, deduped, delivered, incidentId };
  }

  /** 供集成方安全触发：任何异常都不得影响主业务流程。 */
  async safeEmit(input: EmitAlertInput): Promise<void> {
    try {
      await this.emit(input);
    } catch (err) {
      this.logger.warn(`告警触发失败 ${input.alertType}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
