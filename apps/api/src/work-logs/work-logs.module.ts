import { Module } from '@nestjs/common';
import { OwnerModule } from '../owner/owner.module';
import { AdminWorkLogsController } from './admin-work-logs.controller';
import { OwnerWorkLogsController } from './owner-work-logs.controller';

@Module({
  imports: [OwnerModule],
  controllers: [AdminWorkLogsController, OwnerWorkLogsController],
})
export class WorkLogsModule {}
