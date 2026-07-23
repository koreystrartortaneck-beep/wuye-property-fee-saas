import { Module } from '@nestjs/common';
import { PaymentModule } from '../payment/payment.module';
import { PilotBootstrapController } from './pilot-bootstrap.controller';

/** 一次性灰度联调引导模块，联调完成后移除。 */
@Module({
  imports: [PaymentModule],
  controllers: [PilotBootstrapController],
})
export class PilotBootstrapModule {}
