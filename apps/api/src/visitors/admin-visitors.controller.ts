import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery } from '../common/pagination';
import { VisitorsService } from './visitors.service';

class AdminPassQuery extends PageQuery {
  @IsOptional()
  @IsString()
  communityId?: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  date?: string; // YYYY-MM-DD
}

@Controller('admin/visitor-passes')
@UseGuards(AdminGuard, RolesGuard)
export class AdminVisitorsController {
  constructor(private readonly service: VisitorsService) {}

  @Get()
  list(@Query() q: AdminPassQuery) {
    return this.service.adminList(q);
  }

  @Post(':id/verify')
  verify(@Param('id') id: string) {
    return this.service.verify(id);
  }
}
