import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { TICKET_STATUSES, TICKET_TYPES, TicketStatus, TicketType } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery } from '../common/pagination';
import { TicketsService } from './tickets.service';

class AdminListQuery extends PageQuery {
  @IsOptional()
  @IsString()
  communityId?: string;

  @IsOptional()
  @IsIn(TICKET_TYPES as unknown as string[])
  type?: TicketType;

  @IsOptional()
  @IsIn(TICKET_STATUSES as unknown as string[])
  status?: TicketStatus;
}

class ProcessDto {
  @IsString()
  @IsNotEmpty()
  assigneeName!: string;
}

class DoneDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  replyContent!: string;
}

@Controller('admin/tickets')
@UseGuards(AdminGuard, RolesGuard)
export class AdminTicketsController {
  constructor(private readonly service: TicketsService) {}

  @Get()
  list(@Query() q: AdminListQuery) {
    return this.service.adminList(q);
  }

  @Post(':id/process')
  process(@Param('id') id: string, @Body() dto: ProcessDto) {
    return this.service.process(id, dto.assigneeName);
  }

  @Post(':id/done')
  done(@Param('id') id: string, @Body() dto: DoneDto) {
    return this.service.done(id, dto.replyContent);
  }

  @Post(':id/close')
  close(@Param('id') id: string) {
    return this.service.close(id);
  }
}
