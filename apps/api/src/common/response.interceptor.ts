import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/** 成功响应统一包装为 {code:0, message:'ok', data}，HTTP 恒 200（spec §7） */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    ctx.switchToHttp().getResponse().status(200);
    return next.handle().pipe(map((data) => ({ code: 0, message: 'ok', data: data ?? null })));
  }
}
