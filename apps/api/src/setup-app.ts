import { INestApplication, ValidationPipe } from '@nestjs/common';
import { GlobalExceptionFilter } from './common/http-exception.filter';
import { ResponseInterceptor } from './common/response.interceptor';
import { TenantContextInterceptor } from './tenant/tenant-context.interceptor';

/** 生产与测试共用的应用装配（前缀/校验/响应协议/租户上下文） */
export function setupApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new ResponseInterceptor(), new TenantContextInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter());
}
