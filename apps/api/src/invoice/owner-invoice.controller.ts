import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { INVOICE_TITLE_TYPES, InvoiceTitleType } from '@pf/shared';
import { Current, CurrentOwner } from '../auth/current.decorator';
import { OwnerGuard } from '../auth/owner.guard';
import { InvoiceService } from './invoice.service';

class ApplyInvoiceDto {
  @IsString()
  @IsNotEmpty()
  orderNo!: string;

  @IsIn(INVOICE_TITLE_TYPES as unknown as string[])
  titleType!: InvoiceTitleType;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsOptional()
  @IsString()
  taxNo?: string;

  @IsString()
  @IsNotEmpty()
  deliveryMethod!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  @IsNotEmpty()
  requestId!: string;
}

@Controller('owner/invoices')
@UseGuards(OwnerGuard)
export class OwnerInvoiceController {
  constructor(private readonly service: InvoiceService) {}

  @Post()
  apply(@Current() cur: CurrentOwner, @Body() dto: ApplyInvoiceDto) {
    return this.service.apply({
      orderNo: dto.orderNo,
      wxUserId: cur.ownerId,
      titleType: dto.titleType,
      title: dto.title,
      taxNo: dto.taxNo,
      deliveryMethod: dto.deliveryMethod,
      email: dto.email,
      requestId: dto.requestId,
    });
  }

  @Get()
  list(@Current() cur: CurrentOwner) {
    return this.service.listForOwner(cur.ownerId);
  }
}
