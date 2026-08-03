import { Module } from '@nestjs/common';
import { BindingModule } from '../binding/binding.module';
import { OwnerBillsController, OwnerBillsService } from './owner-bills.controller';
import { OwnerHousesController, OwnerHousesService } from './owner-houses.controller';

@Module({
  imports: [BindingModule],
  controllers: [OwnerHousesController, OwnerBillsController],
  providers: [OwnerHousesService, OwnerBillsService],
  exports: [OwnerHousesService],
})
export class OwnerModule {}
