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
    if (!required || required.length === 0) return true;
    const current = ctx.switchToHttp().getRequest().current as CurrentAdmin | undefined;
    if (!current) throw new BizException(ErrorCode.UNAUTHORIZED);
    if (current.role === 'SUPER_ADMIN') return true;
    if (!required.includes(current.role as AdminRole)) throw new BizException(ErrorCode.FORBIDDEN);
    return true;
  }
}
