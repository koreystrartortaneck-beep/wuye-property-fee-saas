import { Module } from '@nestjs/common';
import { PaymentModule } from '../payment/payment.module';
import { PaymentService } from '../payment/payment.service';
import { BillImportController } from './bill-import.controller';
import { BillImportService } from './bill-import.service';
import { BillRunController, BillsAdminService } from './bill-run.controller';
import { BillRunService } from './bill-run.service';
import { BILL_ORDER_CLOSER, BillWorkflowService } from './bill-workflow.service';
import { FeeRulesController, FeeRulesService } from './fee-rules.controller';
import { MeterController, MeterService } from './meter.controller';
import { ScheduleService } from './schedule.service';
import { SharePoolController, SharePoolService } from './share-pool.controller';

@Module({
  imports: [PaymentModule],
  controllers: [FeeRulesController, MeterController, SharePoolController, BillRunController, BillImportController],
  providers: [
    FeeRulesService,
    MeterService,
    SharePoolService,
    BillRunService,
    BillWorkflowService,
    BillImportService,
    BillsAdminService,
    ScheduleService,
    { provide: BILL_ORDER_CLOSER, useExisting: PaymentService },
  ],
  exports: [MeterService, BillRunService],
})
export class BillingModule {}
