import { Module } from '@nestjs/common';
import { AdminAuthController, AdminAuthService } from './admin-auth.controller';

@Module({
  controllers: [AdminAuthController],
  providers: [AdminAuthService],
})
export class AdminModule {}
