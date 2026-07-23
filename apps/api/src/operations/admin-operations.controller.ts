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
  ) {}

  @Get('metrics')
  getMetrics(@Current() cur: CurrentAdmin, @Query() q: MetricsQuery) {
    return this.metrics.metrics({ tenantId: requireTenant(cur), communityId: q.communityId ?? null });
  }

  @Get('readiness')
  getReadiness(@Current() cur: CurrentAdmin) {
    requireTenant(cur);
    const alertReadiness = this.alerts.readiness();
    return {
      healthy: alertReadiness.healthy,
      checks: [
        {
          name: 'ALERT_DESTINATION',
          healthy: alertReadiness.destinationConfigured,
          detail: alertReadiness.destinationConfigured ? '告警目的地已配置' : '未配置 OPS_ALERT_WEBHOOK',
        },
      ],
    };
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
