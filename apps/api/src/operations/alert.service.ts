import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { request as httpsRequest } from 'node:https';
import { redactAndTruncateText, redactSensitive } from '../audit/audit.service';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
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

/** 群机器人的 JSON 形状。按 webhook 域名自动判定，不需要额外配置项。 */
export type WebhookFlavor = 'wecom' | 'dingtalk' | 'raw';

export function detectWebhookFlavor(url: string): WebhookFlavor {
  /*
   * 自动判定而不是加一个 OPS_ALERT_WEBHOOK_FORMAT 环境变量：
   * 运维只需把机器人地址粘进来，少一个能填错的地方。
   */
  if (url.includes('qyapi.weixin.qq.com')) return 'wecom';
  if (url.includes('oapi.dingtalk.com')) return 'dingtalk';
  return 'raw';
}

/** 告警渲染成一行文本，供群机器人展示 */
export function renderAlertText(payload: AlertDeliveryPayload): string {
  const lines = [
    `【${payload.severity}】${payload.title}`,
    payload.summary ? `说明：${payload.summary}` : '',
    `类型：${payload.alertType}　累计：${payload.occurrences} 次`,
  ].filter(Boolean);
  return lines.join('\n');
}

export function buildWebhookBody(payload: AlertDeliveryPayload, flavor: WebhookFlavor): string {
  /*
   * 形状必须按目的地来。企业微信/钉钉群机器人只认自己的结构，
   * 收到别的 JSON 会返回 200 + errcode，消息其实没发出去 ——
   * 而调用方只看状态码的话会把它记成「已投递」。
   */
  if (flavor === 'wecom') {
    return JSON.stringify({ msgtype: 'text', text: { content: renderAlertText(payload) } });
  }
  if (flavor === 'dingtalk') {
    return JSON.stringify({ msgtype: 'text', text: { content: renderAlertText(payload) } });
  }
  return JSON.stringify(payload);
}

/**
 * 判断响应是否真的投递成功。
 *
 * **不能只看 HTTP 状态码**：企业微信与钉钉的群机器人在参数错误、机器人被移出群、
 * 触发频率限制时，返回的都是 HTTP 200 + `{"errcode":93000,"errmsg":"..."}`。
 * 只看状态码会把这些全记成「告警已投递」——于是真出事时没人收到通知，
 * 而系统的记录显示一切正常。这比没有告警更糟。
 */
export function interpretWebhookResponse(
  statusCode: number,
  rawBody: string,
): { ok: boolean; error?: string } {
  if (statusCode < 200 || statusCode >= 300) {
    return { ok: false, error: `HTTP ${statusCode}` };
  }
  const trimmed = (rawBody || '').trim();
  if (!trimmed) return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 非 JSON 响应：只能以状态码为准（自建 webhook 常直接回 OK 文本）
    return { ok: true };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: true };
  const body = parsed as { errcode?: unknown; errmsg?: unknown };
  if (body.errcode === undefined || body.errcode === null) return { ok: true };
  const code = Number(body.errcode);
  if (Number.isFinite(code) && code !== 0) {
    const msg = typeof body.errmsg === 'string' && body.errmsg ? body.errmsg : '未知错误';
    return { ok: false, error: `errcode=${code} ${msg}` };
  }
  return { ok: true };
}

/** 读取响应体的上限：只用来判成败，不需要全量 */
const MAX_RESPONSE_BYTES = 2048;

/**
 * 默认 HTTPS Webhook 投递器：POST 到 OPS_ALERT_WEBHOOK（仅允许 https）。适配器可替换。
 *
 * 按域名自动适配企业微信/钉钉群机器人的消息结构 —— 物业公司最可能用的就是这两种，
 * 直接粘地址即可，不必再配格式。
 */
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
    const body = buildWebhookBody(payload, detectWebhookFlavor(this.url));
    return new Promise((resolve) => {
      try {
        const req = httpsRequest(
          this.url,
          { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 8000 },
          (res) => {
            const code = res.statusCode ?? 0;
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              // 只收前 2KB：足够判成败，又不会被超大响应拖住
              if (raw.length < MAX_RESPONSE_BYTES) raw += chunk;
            });
            res.on('end', () => {
              const verdict = interpretWebhookResponse(code, raw);
              if (!verdict.ok) {
                this.logger.warn(`告警投递未成功：${verdict.error ?? '未知'}`);
              }
              resolve({ ok: verdict.ok, statusCode: code, error: verdict.error });
            });
            res.on('error', (err: Error) => resolve({ ok: false, statusCode: code, error: err.message }));
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
  /**
   * 最近的告警明细（只读）。
   *
   * 补这个查询是因为此前告警表在界面上完全看不到：只有由 CRITICAL 派生的
   * 「事件」有列表。真实事故里我据此误判过 —— 查事件是 0 条，就以为告警没写进去。
   */
  async list(input: { tenantId: string; alertType?: string; page?: number; pageSize?: number }) {
    const where = {
      tenantId: input.tenantId,
      ...(input.alertType ? { alertType: input.alertType } : {}),
    };
    const q = { page: input.page, pageSize: input.pageSize } as PageQuery;
    const [list, total] = await Promise.all([
      this.prisma.raw.operationalAlert.findMany({
        where,
        ...pageArgs(q),
        orderBy: { lastSeenAt: 'desc' },
        select: {
          id: true,
          alertType: true,
          severity: true,
          status: true,
          title: true,
          summary: true,
          occurrences: true,
          firstSeenAt: true,
          lastSeenAt: true,
          incidentId: true,
        },
      }),
      this.prisma.raw.operationalAlert.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  async safeEmit(input: EmitAlertInput): Promise<void> {
    try {
      await this.emit(input);
    } catch (err) {
      /*
       * 用 error 级别而不是 warn：这是「报警本身失败」——
       * 它意味着接下来任何故障都不会有人知道，是比原故障更严重的一层。
       * 真实事故里支付回调被拒没有留下任何痕迹，我因此多花了半小时才定位。
       */
      this.logger.error(
        `告警写入失败（此后该类故障将无人知晓）type=${input.alertType} dedup=${input.dedupKey}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
