import { Module } from '@nestjs/common';
import { OwnerBillsController, OwnerBillsService } from './owner-bills.controller';
import { OwnerHousesController, OwnerHousesService } from './owner-houses.controller';

@Module({
  controllers: [OwnerHousesController, OwnerBillsController],
  providers: [OwnerHousesService, OwnerBillsService],
  exports: [OwnerHousesService],
})
export class OwnerModule {}
