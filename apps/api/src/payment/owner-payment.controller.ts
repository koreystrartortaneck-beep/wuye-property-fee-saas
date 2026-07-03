import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';
import { Current, CurrentOwner } from '../auth/current.decorator';
import { OwnerGuard } from '../auth/owner.guard';
import { PageQuery } from '../common/pagination';
import { PaymentService } from './payment.service';

class CreatePaymentDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  billIds!: string[];
}

@Controller('owner/payments')
@UseGuards(OwnerGuard)
export class OwnerPaymentController {
  constructor(private readonly service: PaymentService) {}

  @Post()
  create(@Current() cur: CurrentOwner, @Body() dto: CreatePaymentDto) {
    return this.service.createPayment(cur.ownerId, dto.billIds);
  }

  @Post(':orderNo/mock-confirm')
  mockConfirm(@Current() cur: CurrentOwner, @Param('orderNo') orderNo: string) {
    return this.service.mockConfirm(cur.ownerId, orderNo);
  }

  @Get()
  list(@Current() cur: CurrentOwner, @Query() q: PageQuery) {
    return this.service.listPayments(cur.ownerId, q.page, q.pageSize);
  }

  @Get(':orderNo')
  get(@Current() cur: CurrentOwner, @Param('orderNo') orderNo: string) {
    return this.service.getPayment(cur.ownerId, orderNo);
  }
}
