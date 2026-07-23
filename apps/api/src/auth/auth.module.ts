import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OwnerAccountController } from './owner-account.controller';
import { OwnerAccountService } from './owner-account.service';
import { OwnerGuard } from './owner.guard';

const DEFAULT_JWT_SECRET = 'dev-secret-change-me';

/** 解析 JWT 密钥：生产环境缺省或使用公开默认值时直接启动失败（fail closed）。 */
export function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && (!secret || secret === DEFAULT_JWT_SECRET)) {
    throw new Error('生产环境必须配置强 JWT_SECRET（不能为空或使用默认值）');
  }
  return secret || DEFAULT_JWT_SECRET;
}

@Global()
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: resolveJwtSecret(),
    }),
  ],
  controllers: [AuthController, OwnerAccountController],
  providers: [AuthService, OwnerGuard, OwnerAccountService],
  exports: [AuthService, OwnerGuard],
})
export class AuthModule {}
