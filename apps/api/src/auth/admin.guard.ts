import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { AdminJwtPayload, AuthService } from './auth.service';

/**
 * 管理端守卫：校验 admin JWT，注入 req.current。
 * 租户上下文由 TenantContextInterceptor 依据 req.current 绑定。
 * SUPER_ADMIN 默认平台视角（null），可用 X-Tenant-Id 头切换到指定租户。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { current?: unknown }>();
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token) throw new BizException(ErrorCode.UNAUTHORIZED);
    const payload = await this.auth.verifyToken<AdminJwtPayload>(token);
    if (payload.typ !== 'admin') throw new BizException(ErrorCode.UNAUTHORIZED);

    let tenantId = payload.tenantId;
    if (payload.role === 'SUPER_ADMIN') {
      const header = req.headers['x-tenant-id'];
      tenantId = typeof header === 'string' && header ? header : null;
    }

    req.current = { adminId: payload.sub, tenantId, role: payload.role };
    return true;
  }
}
