import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Current, CurrentOwner } from '../auth/current.decorator';
import { OwnerGuard } from '../auth/owner.guard';
import { PageQuery } from '../common/pagination';
import { VisitorsService } from './visitors.service';

class CreatePassDto {
  @IsString()
  @IsNotEmpty()
  houseId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  visitorName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  visitorPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  plateNo?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'visitDate 格式须为 YYYY-MM-DD' })
  visitDate!: string;
}

@Controller('owner/visitor-passes')
@UseGuards(OwnerGuard)
export class OwnerVisitorsController {
  constructor(private readonly service: VisitorsService) {}

  @Post()
  create(@Current() cur: CurrentOwner, @Body() dto: CreatePassDto) {
    return this.service.create(cur.ownerId, dto);
  }

  @Get()
  list(@Current() cur: CurrentOwner, @Query() q: PageQuery) {
    return this.service.myList(cur.ownerId, q);
  }

  @Post(':id/cancel')
  cancel(@Current() cur: CurrentOwner, @Param('id') id: string) {
    return this.service.cancel(cur.ownerId, id);
  }
}
