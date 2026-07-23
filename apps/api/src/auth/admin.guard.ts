import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';
import { AdminJwtPayload, AuthService } from './auth.service';

/**
 * 管理端守卫：校验 admin JWT + 会话有效性（tokenVersion 吊销、账号启用、强制改密受限会话），注入 req.current。
 * 租户上下文由 TenantContextInterceptor 依据 req.current 绑定。
 * SUPER_ADMIN 默认平台视角（null），可用 X-Tenant-Id 头切换到指定租户。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { current?: unknown }>();
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token) throw new BizException(ErrorCode.UNAUTHORIZED);
    const payload = await this.auth.verifyToken<AdminJwtPayload>(token);
    if (payload.typ !== 'admin') throw new BizException(ErrorCode.UNAUTHORIZED);

    // 吊销/禁用校验：tokenVersion 必须与当前一致，账号须启用（跨租户查，用 raw）
    const admin = await this.prisma.raw.adminUser.findUnique({
      where: { id: payload.sub },
      select: { tokenVersion: true, status: true, mustChangePassword: true },
    });
    if (!admin || admin.status !== 'ACTIVE' || admin.tokenVersion !== payload.ver) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '登录状态已失效，请重新登录');
    }

    // 受限会话：必须先改初始密码时，仅放行改密端点
    if (admin.mustChangePassword) {
      const path = req.path || req.url || '';
      if (!path.includes('/admin/auth/change-password')) {
        throw new BizException(ErrorCode.UNAUTHORIZED, '请先修改初始密码');
      }
    }

    let tenantId = payload.tenantId;
    if (payload.role === 'SUPER_ADMIN') {
      const header = req.headers['x-tenant-id'];
      tenantId = typeof header === 'string' && header ? header : null;
    }

    req.current = { adminId: payload.sub, tenantId, role: payload.role };
    return true;
  }
}
