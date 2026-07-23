import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, OwnerJwtPayload } from './auth.service';

/**
 * 业主端守卫：校验 owner JWT + 账号有效性（tokenVersion 吊销、注销匿名化），注入 req.current = {ownerId}。
 * 不设租户上下文（业主天然跨租户）。
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { current?: unknown }>();
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token) throw new BizException(ErrorCode.UNAUTHORIZED);
    const payload = await this.auth.verifyToken<OwnerJwtPayload>(token);
    if (payload.typ !== 'owner') throw new BizException(ErrorCode.UNAUTHORIZED);

    // 吊销/注销校验：账号须存在且未注销，tokenVersion 一致（缺省视为 0，兼容旧令牌）。
    const user = await this.prisma.raw.wxUser.findUnique({
      where: { id: payload.sub },
      select: { tokenVersion: true, deletedAt: true },
    });
    if (!user || user.deletedAt || user.tokenVersion !== (payload.ver ?? 0)) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '登录状态已失效，请重新登录');
    }

    req.current = { ownerId: payload.sub };
    return true;
  }
}
