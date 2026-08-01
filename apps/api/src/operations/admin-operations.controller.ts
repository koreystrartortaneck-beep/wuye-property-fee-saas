import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { PageQuery } from '../common/pagination';
import { type CallbackUrlIssue, describeCallbackUrl, inspectCallbackUrls } from '../payment/callback-url';
import { AlertService } from './alert.service';
import { IncidentService, IncidentStatus } from './incident.service';
import { PilotMetricsService } from './pilot-metrics.service';
import { WxProbeService } from '../wx/wx-probe.service';
import { SchemaVersionService } from './schema-version.service';

const INCIDENT_STATUSES: IncidentStatus[] = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'];

class MetricsQuery {
  @IsOptional()
  @IsString()
  communityId?: string;
}

class ListAlertsDto extends PageQuery {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  alertType?: string;
}

class ListIncidentsDto extends PageQuery {
  @IsOptional()
  @IsIn(INCIDENT_STATUSES as unknown as string[])
  status?: IncidentStatus;
}

class TransitionDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  reason?: string;
}

function requireTenant(cur: CurrentAdmin): string {
  if (!cur.tenantId) throw new BizException(ErrorCode.FORBIDDEN, '请在具体租户视角下查看运营数据');
  return cur.tenantId;
}

/**
 * 运营工作台：灰度指标、告警就绪检查、告警与事件的查看与处置。
 * 事件状态转换幂等且写审计；均为租户内数据。
 */
@Controller('admin/operations')
@UseGuards(AdminGuard, RolesGuard)
export class AdminOperationsController {
  constructor(
    private readonly metrics: PilotMetricsService,
    private readonly alerts: AlertService,
    private readonly incidents: IncidentService,
    private readonly wxProbe: WxProbeService,
    private readonly schemaVersion: SchemaVersionService,
  ) {}

  @Get('metrics')
  getMetrics(@Current() cur: CurrentAdmin, @Query() q: MetricsQuery) {
    return this.metrics.metrics({ tenantId: requireTenant(cur), communityId: q.communityId ?? null });
  }

  @Get('readiness')
  async getReadiness(@Current() cur: CurrentAdmin) {
    requireTenant(cur);
    /*
     * 迁移状态兼作「线上跑的是哪个版本」的标记。容器启动命令是
     * `prisma migrate deploy && node main.js`，迁移失败服务就起不来、成功也无处可查。
     * 此前每次发布都要临时造探针去猜新版本上线了没，还判断错过一次。
     */
    const schema = await this.schemaVersion.info();
    const alertReadiness = this.alerts.readiness();

    /*
     * 支付与对账模式必须能在界面上看见。
     *
     * 教训：对账单渠道曾被无条件绑到 Mock（永远返回空账期），生产上每天照跑、
     * 批次状态写 COMPLETED、把本地全部交易登记成「微信侧缺失」差异。因为没有任何
     * 地方显示「当前用的是 Mock」，这个问题在真金白银跑了一周之后才被发现——
     * 只能靠对比 channelFileHash 恒为 SHA256("[]") 才认出来。
     * 凡是「真实 / 模拟」的开关，都必须在就绪检查里暴露。
     */
    const payMode = process.env.PAY_MODE ?? '(未配置)';
    const isRealPay = payMode === 'wxpay';
    /*
     * 每日对账定时任务真正依赖的环境变量。少一个就静默跳过整天的对账，
     * 所以要在这里点名，而不是只判断 PAY_MODE。
     */
    const reconcileMissing = isRealPay
      ? (
          [
            ['WX_PAY_ALLOWED_TENANT_ID', process.env.WX_PAY_ALLOWED_TENANT_ID],
            ['WX_PAY_MERCHANT_SERIAL', process.env.WX_PAY_MERCHANT_SERIAL],
            ['WX_PAY_MCH_ID', process.env.WX_PAY_MCH_ID],
            ['WX_PAY_APP_ID/WX_APPID', process.env.WX_PAY_APP_ID ?? process.env.WX_APPID],
          ] as Array<[string, string | undefined]>
        )
          .filter(([, v]) => !v)
          .map(([k]) => k)
      : [];

    /*
     * 回调地址自检。事故复盘的产物：两笔已扣款的支付没入账，最终确认微信回调从未到达，
     * 而「回调地址配得对不对」在此前没有任何地方能看出来 ——
     * WX_PAY_NOTIFY_URL 是必需变量所以一定有值，但值可以是错的（最常见是漏 /api/v1）。
     * 配错的唯一表现就是「钱扣了、账单不变」，最像后端 bug，最难指向配置。
     */
    const callbackIssues = isRealPay
      ? inspectCallbackUrls(process.env.WX_PAY_NOTIFY_URL, process.env.WX_PAY_REFUND_NOTIFY_URL)
      : [];

    // 三类订阅消息模板缺哪个就发不出哪种提醒，逐个列出而不是笼统说「未配置」
    const missingTemplates = (['WX_TMPL_BILL_CREATED', 'WX_TMPL_DUE_SOON', 'WX_TMPL_OVERDUE'] as const).filter(
      (name) => !process.env[name],
    );

    const checks = [
      {
        name: 'SCHEMA_MIGRATIONS',
        healthy: schema.ok,
        detail: schema.detail,
      },
      {
        name: 'ALERT_DESTINATION',
        healthy: alertReadiness.destinationConfigured,
        detail: alertReadiness.destinationConfigured ? '告警目的地已配置' : '未配置 OPS_ALERT_WEBHOOK',
      },
      {
        name: 'PAY_MODE',
        healthy: isRealPay,
        detail: isRealPay
          ? '真实微信支付（wxpay）'
          : `当前为 ${payMode}，不会产生真实收款`,
      },
      {
        /*
         * 只看 PAY_MODE 不够。
         *
         * 每日对账（ReconciliationService.runDaily）除了 PAY_MODE=wxpay，还要求
         * WX_PAY_ALLOWED_TENANT_ID / WX_PAY_MERCHANT_SERIAL / WX_PAY_MCH_ID /
         * WX_PAY_APP_ID（或 WX_APPID）—— 缺任何一个就**静默 return**，
         * 那一天的对账根本没跑，而这里原本仍然显示「会真实下载微信账单并逐笔核对」。
         *
         * 对账是「发现漏账」的最后一道防线：它不跑，业主付了钱而本地没入账这类差异
         * 就没有任何机制会发现。一个宣称已生效、实际静默停摆的检查，
         * 比没有这个检查更糟 —— 它让人不再去看。
         *
         * 所以这里逐个点名缺哪个变量，而不是只报「不健康」。
         */
        name: 'RECONCILIATION_CHANNEL',
        healthy: isRealPay && reconcileMissing.length === 0,
        detail: !isRealPay
          ? '对账使用模拟渠道：账期恒为空，本地交易会被全部误判为「微信侧缺失」，真实资金差异无法发现'
          : reconcileMissing.length > 0
            ? `每日对账不会运行：缺少 ${reconcileMissing.join('、')}（缺任一项即静默跳过，漏账无法被发现）`
            : '对账会真实下载微信账单并逐笔核对',
      },
      {
        /*
         * WX_MODE 决定业主登录与手机号授权走真实微信还是 Mock（Mock 会伪造 openid
         * 与手机号）。原先取值非 'real' 会静默退回 Mock，控制台一个手误就让业主
         * 变成假身份，而界面上看不出来。现在配置错会启动失败，这里再做一层回显。
         */
        name: 'WX_MODE',
        healthy: process.env.WX_MODE === 'real',
        detail:
          process.env.WX_MODE === 'real'
            ? '业主登录与手机号授权走真实微信接口'
            : `当前为 ${process.env.WX_MODE ?? '(未配置)'}，业主身份是伪造的`,
      },
      {
        /*
         * 投递任务此前默认关闭（要配 OUTBOX_DISPATCH_ENABLED=true 才跑），而生产上
         * 没配，于是它从未执行过一次——事件只进不出，实测积压 24 条、80 秒纹丝不动，
         * 后台却没有任何地方提示「投递是关着的」。现已改为默认开启，这里做一层回显，
         * 万一有人显式关掉也能一眼看到。
         */
        name: 'OUTBOX_DISPATCH',
        healthy: process.env.OUTBOX_DISPATCH_ENABLED !== 'false',
        detail:
          process.env.OUTBOX_DISPATCH_ENABLED !== 'false'
            ? '通知投递任务运行中（每 30 秒一轮）'
            : '已被 OUTBOX_DISPATCH_ENABLED=false 关闭：通知事件只进不出，业主收不到任何提醒',
      },
      {
        name: 'PAYMENT_CALLBACK_URL',
        healthy: callbackIssues.length === 0,
        detail: !isRealPay
          ? '非真实支付模式，不涉及微信回调'
          : callbackIssues.length === 0
            ? `回调地址 ${describeCallbackUrl(process.env.WX_PAY_NOTIFY_URL)}（形状正确；连通性见 callback-probe）`
            : callbackIssues.map((i: CallbackUrlIssue) => i.detail).join('；'),
      },
      {
        /*
         * 订阅消息模板同样是「静默失效」：模板 ID 没配时账单照发、通知全部
         * FAILED，业主什么也收不到，而唯一线索是通知记录里逐条的失败原因。
         * 生产实测 16 条通知全是 FAILED / SKIPPED。
         */
        name: 'NOTIFY_TEMPLATES',
        healthy: missingTemplates.length === 0,
        detail:
          missingTemplates.length === 0
            ? '订阅消息模板已配置，业主可收到出账/到期/逾期提醒'
            : `缺少模板环境变量 ${missingTemplates.join('、')}，业主收不到对应提醒`,
      },
    ];

    return {
      healthy: checks.every((c) => c.healthy),
      checks,
      // 供部署脚本直接比对：镜像水位 vs 已应用水位
      schemaVersion: {
        latestInImage: schema.latestInImage,
        latestApplied: schema.latestApplied,
        pendingCount: schema.pendingCount,
        failed: schema.failed,
      },
    };
  }

  /**
   * 微信开放接口连通性探测。
   *
   * 订阅消息下发曾稳定失败于 `fetch failed`——网络层错误，管理端只看到这四个字，
   * 无从判断是域名不可达、TLS 失败还是凭据不对。这个端点把 HTTPS 直连与云托管
   * 开放接口 HTTP 代理各探一次，把 errno（ENOTFOUND / EPROTO 等）也带出来，
   * 让「到底哪一层不通」有据可查而不是靠猜。
   */
  @Get('wx-probe')
  probeWx(@Current() cur: CurrentAdmin) {
    requireTenant(cur);
    return this.wxProbe.probe();
  }

  /**
   * 回调地址连通性实测。
   *
   * 就绪检查只判形状（不外呼），这里真的往 WX_PAY_NOTIFY_URL 发一次请求，
   * 回答「微信的回调能不能打到这个服务上」。
   *
   * 判据是**必须返回 401 且是验签失败**：
   *   · 401 验签失败 → 地址可达、路由是我们的、验签逻辑在跑 —— 这是正确结果
   *   · 404 → 地址能连上但路由不对（最常见是漏了 /api/v1 前缀）
   *   · 200 → 更糟：说明这个地址上有个东西无条件接受未验签的回调
   *   · 连不上 → 微信也连不上
   *
   * 为什么用「发一个必然失败的请求」而不是 GET 探活：GET 会返回 404
   * （路由只注册了 POST），区分不了「路由不存在」和「方法不对」。
   * 发一个签名一定不对的 POST，才能确认打到的正是验签那段代码。
   */
  @Get('callback-probe')
  async probeCallback(@Current() cur: CurrentAdmin) {
    requireTenant(cur);
    const url = process.env.WX_PAY_NOTIFY_URL;
    const issues = inspectCallbackUrls(url, process.env.WX_PAY_REFUND_NOTIFY_URL);
    if (!url) return { url: '(未配置)', ok: false, verdict: '未配置 WX_PAY_NOTIFY_URL', issues };

    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 故意不带任何 Wechatpay-* 签名头：期望被验签拒绝
        body: JSON.stringify({ id: 'callback-probe', resource: {} }),
        signal: AbortSignal.timeout(8000),
      });
      const text = (await res.text()).slice(0, 300);
      const rejected = res.status === 401;
      return {
        url: describeCallbackUrl(url),
        ok: rejected && issues.length === 0,
        httpStatus: res.status,
        elapsedMs: Date.now() - started,
        verdict: rejected
          ? '可达，且未签名的回调被正确拒绝（回调链路正常）'
          : res.status === 404
            ? '可达但路由不存在——微信的回调会打到一个 404 上，钱永远不会入账'
            : `返回了意外的 ${res.status}：这个地址上的服务不是在做验签`,
        body: text,
        issues,
      };
    } catch (error) {
      /*
       * 这一支就是本次事故最可能的形态：微信连不上，于是回调从未到达，
       * 而系统里除了「钱扣了、账单不变」之外没有任何迹象。
       */
      return {
        url: describeCallbackUrl(url),
        ok: false,
        elapsedMs: Date.now() - started,
        verdict: '请求发不出去或超时：微信同样连不上这个地址，回调不会到达',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        issues,
      };
    }
  }

  /**
   * 最近的告警明细。
   *
   * 为什么补这个：此前只有「事件（Incident）」列表，而事件只由 CRITICAL 告警派生 ——
   * WARNING 级的告警根本没有任何界面能看到，CRITICAL 的也只能看到派生出的事件。
   *
   * 真实事故里这个缺口让我判断错了：业主付款卡住，我用错签名的回调探了两次，
   * 查「事件」是 0 条，就据此认为「告警没写进去」。实际上我查的是派生对象，
   * 不是告警本身 —— 一个看不见的表让我把观察不到当成没发生。
   */
  @Get('alerts')
  listAlerts(@Current() cur: CurrentAdmin, @Query() q: ListAlertsDto) {
    return this.alerts.list({
      tenantId: requireTenant(cur),
      alertType: q.alertType,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('incidents')
  listIncidents(@Current() cur: CurrentAdmin, @Query() q: ListIncidentsDto) {
    return this.incidents.list({ tenantId: requireTenant(cur), status: q.status, page: q.page, pageSize: q.pageSize });
  }

  @Get('incidents/:id')
  getIncident(@Current() cur: CurrentAdmin, @Param('id') id: string) {
    return this.incidents.get(requireTenant(cur), id);
  }

  @Post('incidents/:id/acknowledge')
  acknowledge(@Current() cur: CurrentAdmin, @Param('id') id: string, @Body() dto: TransitionDto) {
    return this.incidents.acknowledge({ tenantId: requireTenant(cur), id, adminId: cur.adminId, reason: dto.reason ?? null });
  }

  @Post('incidents/:id/resolve')
  resolve(@Current() cur: CurrentAdmin, @Param('id') id: string, @Body() dto: TransitionDto) {
    return this.incidents.resolve({ tenantId: requireTenant(cur), id, adminId: cur.adminId, reason: dto.reason ?? null });
  }
}
