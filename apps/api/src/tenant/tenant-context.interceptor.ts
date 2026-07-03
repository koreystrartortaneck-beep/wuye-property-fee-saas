import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { CurrentAdmin } from '../auth/current.decorator';
import { runWithTenantSync } from './tenant-cls';

/**
 * 管理端请求的租户上下文拦截器。
 * AdminGuard 把身份放进 req.current，这里在订阅处理器的同步时刻
 * 用 als.run 包裹，使控制器及其整个异步链路都处于租户上下文内。
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const current = ctx.switchToHttp().getRequest().current as CurrentAdmin | undefined;
    if (!current || !('adminId' in current)) return next.handle();

    return new Observable((subscriber) => {
      const sub = runWithTenantSync(current.tenantId, () => next.handle().subscribe(subscriber));
      return () => sub.unsubscribe();
    });
  }
}
