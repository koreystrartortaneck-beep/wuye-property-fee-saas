import { Module } from '@nestjs/common';
import { OwnerModule } from '../owner/owner.module';
import { AdminVisitorsController } from './admin-visitors.controller';
import { OwnerVisitorsController } from './owner-visitors.controller';
import { VisitorsService } from './visitors.service';

@Module({
  imports: [OwnerModule],
  controllers: [OwnerVisitorsController, AdminVisitorsController],
  providers: [VisitorsService],
})
export class VisitorsModule {}
