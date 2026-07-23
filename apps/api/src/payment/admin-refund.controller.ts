import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
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
