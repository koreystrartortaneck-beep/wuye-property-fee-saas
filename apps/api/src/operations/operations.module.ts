import { Global, Module } from '@nestjs/common';
import { AdminOperationsController } from './admin-operations.controller';
import { ALERT_DISPATCHER, AlertService, WebhookAlertDispatcher } from './alert.service';
import { IncidentService } from './incident.service';
import { PilotMetricsService } from './pilot-metrics.service';

/**
 * 运营模块（全局）：告警、事件、灰度指标。设为全局以便支付/退款/对账等生产方
 * 直接注入 AlertService 触发告警，避免模块循环依赖。
 */
@Global()
@Module({
  controllers: [AdminOperationsController],
  providers: [
    IncidentService,
    AlertService,
    PilotMetricsService,
    WebhookAlertDispatcher,
    { provide: ALERT_DISPATCHER, useExisting: WebhookAlertDispatcher },
  ],
  exports: [AlertService, IncidentService, PilotMetricsService],
})
export class OperationsModule {}
