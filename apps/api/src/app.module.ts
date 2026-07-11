import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { NotifyModule } from './notify/notify.module';
import { PaymentModule } from './payment/payment.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { TicketsModule } from './tickets/tickets.module';
import { UploadModule } from './upload/upload.module';
import { VisitorsModule } from './visitors/visitors.module';
import { WorkLogsModule } from './work-logs/work-logs.module';
import { ServicesModule } from './services/services.module';
import { CouponsModule } from './coupons/coupons.module';
import { HealthController } from './health.controller';
import { OwnerModule } from './owner/owner.module';
import { PrismaModule } from './prisma/prisma.module';
import { WxModule } from './wx/wx.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    WxModule,
    AuthModule,
    AdminModule,
    OwnerModule,
    NotifyModule,
    BillingModule,
    PaymentModule,
    UploadModule,
    TicketsModule,
    AnnouncementsModule,
    VisitorsModule,
    WorkLogsModule,
    ServicesModule,
    CouponsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
