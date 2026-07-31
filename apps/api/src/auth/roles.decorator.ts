import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRole, ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { CurrentAdmin } from './current.decorator';

export const ROLES_KEY = 'required_roles';

/** 标注接口所需管理角色；SUPER_ADMIN 恒通过 */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const req = ctx.switchToHttp().getRequest();
    const current = req.current as CurrentAdmin | undefined;

    /*
     * 只读平台管理员：任何非 GET/HEAD 请求一律拒绝，与该端点标了什么 @Roles 无关。
     *
     * 这个判断必须在「没标 @Roles 就放行」之前，而且必须按 HTTP 方法而不是靠注解：
     * 管理端**大多数**写端点既没有方法级也没有类级 @Roles —— 靠注解等于默认
     * 放行，靠方法才是 fail-closed。放在这里而不是单独一个守卫，是因为它必须与
     * 「SUPER_ADMIN 恒通过」这条规则在同一处，否则很容易被后来的改动绕过。
     */
    if (current?.role === 'PLATFORM_READONLY') {
      const method = String(req.method ?? '').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        throw new BizException(ErrorCode.FORBIDDEN, '只读平台账号不能执行写操作');
      }
      return true;
    }

    if (!required || required.length === 0) return true;
    if (!current) throw new BizException(ErrorCode.UNAUTHORIZED);
    if (current.role === 'SUPER_ADMIN') return true;
    if (!required.includes(current.role as AdminRole)) throw new BizException(ErrorCode.FORBIDDEN);
    return true;
  }
}
