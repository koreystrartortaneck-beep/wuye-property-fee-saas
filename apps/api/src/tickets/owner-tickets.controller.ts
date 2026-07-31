import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { TICKET_STATUSES, TICKET_TYPES, TicketStatus, TicketType } from '@pf/shared';
import { Current, CurrentOwner } from '../auth/current.decorator';
import { OwnerGuard } from '../auth/owner.guard';
import { PageQuery } from '../common/pagination';
import { TicketsService } from './tickets.service';

class CreateTicketDto {
  @IsString()
  @IsNotEmpty()
  houseId!: string;

  @IsIn(TICKET_TYPES as unknown as string[])
  type!: TicketType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  content!: string;

  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  images: string[] = [];
}

class ListTicketsQuery extends PageQuery {
  @IsOptional()
  @IsIn(TICKET_TYPES as unknown as string[])
  type?: TicketType;

  @IsOptional()
  @IsIn(TICKET_STATUSES as unknown as string[])
  status?: TicketStatus;
}

class RateDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  /*
   * 191 是数据库列宽（Prisma 对 String 的默认映射 VARCHAR(191)）。
   * 原先写 200：业主填 192–200 字能通过 DTO 校验，却在写库时被 Prisma 以 P2000
   * 拒绝，接口返回「服务器内部错误」。上限必须不超过列容量，否则标了也白标。
   */
  @MaxLength(191)
  comment?: string;
}

@Controller('owner/tickets')
@UseGuards(OwnerGuard)
export class OwnerTicketsController {
  constructor(private readonly service: TicketsService) {}

  @Post()
  create(@Current() cur: CurrentOwner, @Body() dto: CreateTicketDto) {
    return this.service.create(cur.ownerId, dto);
  }

  @Get()
  list(@Current() cur: CurrentOwner, @Query() q: ListTicketsQuery) {
    return this.service.myList(cur.ownerId, q);
  }

  @Get(':id')
  detail(@Current() cur: CurrentOwner, @Param('id') id: string) {
    return this.service.myDetail(cur.ownerId, id);
  }

  @Post(':id/rate')
  rate(@Current() cur: CurrentOwner, @Param('id') id: string, @Body() dto: RateDto) {
    return this.service.rate(cur.ownerId, id, dto.rating, dto.comment);
  }
}
