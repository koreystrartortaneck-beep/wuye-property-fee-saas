import { Module } from '@nestjs/common';
import { OwnerModule } from '../owner/owner.module';
import { AdminAnnouncementsController } from './admin-announcements.controller';
import { OwnerAnnouncementsController } from './owner-announcements.controller';

@Module({
  imports: [OwnerModule],
  controllers: [AdminAnnouncementsController, OwnerAnnouncementsController],
})
export class AnnouncementsModule {}
