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

    /*
     * 受限会话：必须先改初始密码时，仅放行改密端点。
     *
     * 只约束**密码**通道：pv 令牌（微信授权手机号换发）不受限 ——
     * 那条通道的身份证明是运营商核验的手机号持有，与密码是否改过无关；
     * 拦它等于强迫不用电脑的物业员工去找一台电脑。
     *
     * 用 endsWith 精确匹配而不是 includes：includes 的判据是「路径里出现过这个串」，
     * 而 req.path 取不到时回退的 req.url **带查询串** ——
     * `/admin/tenants?next=/admin/auth/change-password` 就会被放行。
     * Express 下 req.path 始终有值，所以这不是已存在的漏洞；
     * 但一个「靠上游恰好总有值」才安全的判据，不该留在鉴权路径里。
     */
    if (admin.mustChangePassword && !payload.pv) {
      const rawPath = (req.path || req.url || '').split('?')[0];
      if (!rawPath.endsWith('/admin/auth/change-password')) {
        throw new BizException(ErrorCode.UNAUTHORIZED, '请先修改初始密码');
      }
    }

    let tenantId = payload.tenantId;
    /*
     * 平台视角（可跨租户读）。只读角色与超管享有同样的读范围——它的用途正是
     * 「平台侧看数据」；写操作由 RolesGuard 按 HTTP 方法一律拒绝。
     */
    if (payload.role === 'SUPER_ADMIN' || payload.role === 'PLATFORM_READONLY') {
      const header = req.headers['x-tenant-id'];
      tenantId = typeof header === 'string' && header ? header : null;
      /*
       * 必须校验这个租户真的存在。
       *
       * 不校验的话，选了一个已删除（或本地缓存里过期）的租户之后，
       * prisma.t 会按一个不存在的 tenantId 过滤 —— **整个后台静默全空**：
       * 没有报错、没有提示，运营只看到「什么数据都没有」，
       * 根本想不到是视角选错了。
       *
       * 用专门的错误码而不是 40400：前端据此清掉本地选中的租户、切回平台视角，
       * 否则会锁死（租户列表接口也带这个头，一起失败就换不回去了）。
       */
      if (tenantId) {
        const tenant = await this.prisma.raw.tenant.findUnique({
          where: { id: tenantId },
          select: { id: true },
        });
        if (!tenant) throw new BizException(ErrorCode.TENANT_VIEW_INVALID);
      }
    }

    req.current = { adminId: payload.sub, tenantId, role: payload.role };
    return true;
  }
}
