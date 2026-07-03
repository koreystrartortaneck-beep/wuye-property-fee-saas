import { Module } from '@nestjs/common';
import { OwnerHousesController, OwnerHousesService } from './owner-houses.controller';

@Module({
  controllers: [OwnerHousesController],
  providers: [OwnerHousesService],
  exports: [OwnerHousesService],
})
export class OwnerModule {}
