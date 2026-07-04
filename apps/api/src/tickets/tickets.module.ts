import { Module } from '@nestjs/common';
import { OwnerModule } from '../owner/owner.module';
import { AdminTicketsController } from './admin-tickets.controller';
import { OwnerTicketsController } from './owner-tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [OwnerModule],
  controllers: [OwnerTicketsController, AdminTicketsController],
  providers: [TicketsService],
})
export class TicketsModule {}
