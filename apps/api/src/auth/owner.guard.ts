import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { AuthService, OwnerJwtPayload } from './auth.service';

/** 业主端守卫：校验 owner JWT，注入 req.current = {ownerId}。不设租户上下文。 */
@Injectable()
export class OwnerGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { current?: unknown }>();
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token) throw new BizException(ErrorCode.UNAUTHORIZED);
    const payload = await this.auth.verifyToken<OwnerJwtPayload>(token);
    if (payload.typ !== 'owner') throw new BizException(ErrorCode.UNAUTHORIZED);
    req.current = { ownerId: payload.sub };
    return true;
  }
}
