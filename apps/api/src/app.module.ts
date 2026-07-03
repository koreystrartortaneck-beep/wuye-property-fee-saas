import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
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
    BillingModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
