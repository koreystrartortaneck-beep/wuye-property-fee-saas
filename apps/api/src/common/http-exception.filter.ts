import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Response } from 'express';
import { ErrorCode } from '@pf/shared';
import { BizException } from './biz.exception';

/**
 * 全局异常 → 统一 {code,message} 响应，HTTP 始终 200（spec §7）。
 * 未知异常记日志并返回 50000，不泄漏堆栈。
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof BizException) {
      res.status(200).json({ code: exception.code, message: exception.message });
      return;
    }

    if (exception instanceof BadRequestException) {
      // class-validator 校验失败：取第一条错误信息
      const body = exception.getResponse() as { message?: string | string[] };
      const detail = Array.isArray(body.message) ? body.message[0] : body.message;
      res.status(200).json({
        code: ErrorCode.VALIDATION.code,
        message: detail || ErrorCode.VALIDATION.message,
      });
      return;
    }

    if (exception instanceof UnauthorizedException) {
      res.status(200).json(ErrorCode.UNAUTHORIZED);
      return;
    }
    if (exception instanceof ForbiddenException) {
      res.status(200).json(ErrorCode.FORBIDDEN);
      return;
    }
    if (exception instanceof NotFoundException) {
      res.status(200).json(ErrorCode.NOT_FOUND);
      return;
    }
    if (exception instanceof HttpException) {
      res.status(200).json({ code: 40000 + exception.getStatus(), message: exception.message });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(200).json(ErrorCode.INTERNAL);
  }
}
