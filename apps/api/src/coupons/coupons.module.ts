import { Module } from '@nestjs/common';
import { OwnerModule } from '../owner/owner.module';
import { AdminCouponsController } from './admin-coupons.controller';
import { CouponsService } from './coupons.service';
import { OwnerCouponsController } from './owner-coupons.controller';

@Module({
  imports: [OwnerModule],
  controllers: [OwnerCouponsController, AdminCouponsController],
  providers: [CouponsService],
})
export class CouponsModule {}
