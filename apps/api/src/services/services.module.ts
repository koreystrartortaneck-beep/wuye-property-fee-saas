import { Module } from '@nestjs/common';
import { OwnerModule } from '../owner/owner.module';
import { AdminServicesController } from './admin-services.controller';
import { OwnerServicesController } from './owner-services.controller';
import { ServicesService } from './services.service';

@Module({
  imports: [OwnerModule],
  controllers: [OwnerServicesController, AdminServicesController],
  providers: [ServicesService],
})
export class ServicesModule {}
