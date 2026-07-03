import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface CurrentOwner {
  ownerId: string;
}

export interface CurrentAdmin {
  adminId: string;
  tenantId: string | null;
  role: string;
}

/** 取守卫注入的当前身份（owner 或 admin） */
export const Current = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().current;
});
