import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { WxModule } from './wx/wx.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WxModule, AuthModule, AdminModule],
  controllers: [HealthController],
})
export class AppModule {}
