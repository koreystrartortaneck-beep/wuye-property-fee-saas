import { Module } from '@nestjs/common';
import { FeeRulesController, FeeRulesService } from './fee-rules.controller';
import { MeterController, MeterService } from './meter.controller';
import { SharePoolController, SharePoolService } from './share-pool.controller';

@Module({
  controllers: [FeeRulesController, MeterController, SharePoolController],
  providers: [FeeRulesService, MeterService, SharePoolService],
  exports: [MeterService],
})
export class BillingModule {}
