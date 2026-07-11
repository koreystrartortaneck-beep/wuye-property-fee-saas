import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Current, CurrentOwner } from '../auth/current.decorator';
import { OwnerGuard } from '../auth/owner.guard';
import { PageQuery } from '../common/pagination';
import { ServicesService } from './services.service';

class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  houseId!: string;

  @IsString()
  @IsNotEmpty()
  serviceItemId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  contactName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  contactPhone!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'expectDate 格式须为 YYYY-MM-DD' })
  expectDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}

@Controller('owner')
@UseGuards(OwnerGuard)
export class OwnerServicesController {
  constructor(private readonly service: ServicesService) {}

  @Get('service-items')
  items(@Current() cur: CurrentOwner, @Query('houseId') houseId: string) {
    return this.service.availableItems(cur.ownerId, houseId);
  }

  @Post('service-orders')
  create(@Current() cur: CurrentOwner, @Body() dto: CreateOrderDto) {
    return this.service.createOrder(cur.ownerId, dto);
  }

  @Get('service-orders')
  myOrders(@Current() cur: CurrentOwner, @Query() q: PageQuery) {
    return this.service.myOrders(cur.ownerId, q);
  }

  @Post('service-orders/:id/cancel')
  cancel(@Current() cur: CurrentOwner, @Param('id') id: string) {
    return this.service.cancelOrder(cur.ownerId, id);
  }
}
