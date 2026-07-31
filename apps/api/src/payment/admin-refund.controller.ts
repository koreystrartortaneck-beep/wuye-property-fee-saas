import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { Roles, RolesGuard } from '../auth/roles.decorator';
import { RefundService } from './refund.service';

/** 退款不接受客户端传入金额，一律按原订单全额退款。 */
class CreateRefundDto {
  @IsString()
  @IsNotEmpty()
  orderNo!: string;

  @IsString()
  @IsNotEmpty()
  reason!: string;

  @IsString()
  @IsNotEmpty()
  requestId!: string;
}

@Controller('admin/refunds')
@UseGuards(AdminGuard, RolesGuard)
export class AdminRefundController {
  constructor(private readonly service: RefundService) {}

  /*
   * 退款是把钱退出去，风险最高，限定 TENANT_ADMIN。
   *
   * 背景：RolesGuard 的规则是「没标 @Roles 就放行所有已登录管理员」。此前退款、
   * 冲正、线下核销、出账、催缴全都没标，等于任何管理员账号都能动钱。目前生产只有
   * 一个 TENANT_ADMIN 账号，所以还没有实际风险；但 schema 里 STAFF 角色是存在的，
   * 一旦为收费员开了 STAFF 账号，就会立刻变成真实的越权。现在加上零成本。
   */
  @Roles('TENANT_ADMIN')
  @Post()
  create(@Current() cur: CurrentAdmin, @Body() dto: CreateRefundDto) {
    return this.service.createRefund({
      orderNo: dto.orderNo,
      adminId: cur.adminId,
      actingTenantId: cur.tenantId,
      reason: dto.reason,
      requestId: dto.requestId,
    });
  }

  @Get(':orderNo')
  get(@Current() cur: CurrentAdmin, @Param('orderNo') orderNo: string) {
    return this.service.getRefund(orderNo, cur.tenantId);
  }
}
