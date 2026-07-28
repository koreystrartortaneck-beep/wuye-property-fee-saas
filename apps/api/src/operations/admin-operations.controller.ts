import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { PageQuery } from '../common/pagination';
import { AlertService } from './alert.service';
import { IncidentService, IncidentStatus } from './incident.service';
import { PilotMetricsService } from './pilot-metrics.service';
import { WxProbeService } from '../wx/wx-probe.service';

const INCIDENT_STATUSES: IncidentStatus[] = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'];

class MetricsQuery {
  @IsOptional()
  @IsString()
  communityId?: string;
}

class ListIncidentsDto extends PageQuery {
  @IsOptional()
  @IsIn(INCIDENT_STATUSES as unknown as string[])
  status?: IncidentStatus;
}

class TransitionDto {
  @IsOptional()
  @IsString()
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
  ) {}

  @Get('metrics')
  getMetrics(@Current() cur: CurrentAdmin, @Query() q: MetricsQuery) {
    return this.metrics.metrics({ tenantId: requireTenant(cur), communityId: q.communityId ?? null });
  }

  @Get('readiness')
  getReadiness(@Current() cur: CurrentAdmin) {
    requireTenant(cur);
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

    // 三类订阅消息模板缺哪个就发不出哪种提醒，逐个列出而不是笼统说「未配置」
    const missingTemplates = (['WX_TMPL_BILL_CREATED', 'WX_TMPL_DUE_SOON', 'WX_TMPL_OVERDUE'] as const).filter(
      (name) => !process.env[name],
    );

    const checks = [
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
        name: 'RECONCILIATION_CHANNEL',
        healthy: isRealPay,
        detail: isRealPay
          ? '对账会真实下载微信账单并逐笔核对'
          : '对账使用模拟渠道：账期恒为空，本地交易会被全部误判为「微信侧缺失」，真实资金差异无法发现',
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

    return { healthy: checks.every((c) => c.healthy), checks };
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
