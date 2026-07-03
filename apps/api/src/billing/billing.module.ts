import { Module } from '@nestjs/common';
import { BillRunController, BillsAdminService } from './bill-run.controller';
import { BillRunService } from './bill-run.service';
import { FeeRulesController, FeeRulesService } from './fee-rules.controller';
import { MeterController, MeterService } from './meter.controller';
import { ScheduleService } from './schedule.service';
import { SharePoolController, SharePoolService } from './share-pool.controller';

@Module({
  controllers: [FeeRulesController, MeterController, SharePoolController, BillRunController],
  providers: [
    FeeRulesService,
    MeterService,
    SharePoolService,
    BillRunService,
    BillsAdminService,
    ScheduleService,
  ],
  exports: [MeterService, BillRunService],
})
export class BillingModule {}
