import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OwnerGuard } from './owner.guard';

@Global()
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'dev-secret-change-me',
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, OwnerGuard],
  exports: [AuthService, OwnerGuard],
})
export class AuthModule {}
