import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';
import { AUDIT_ACTIONS, AuditAction } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery } from '../common/pagination';
import { AuditService } from './audit.service';

export class AuditLogsQuery extends PageQuery {
  @IsOptional()
  @IsIn(AUDIT_ACTIONS as unknown as string[])
  action?: AuditAction;

  @IsOptional()
  @IsString()
  actorId?: string;

  @IsOptional()
  @IsString()
  resourceType?: string;

  @IsOptional()
  @IsString()
  resourceId?: string;

  @IsOptional()
  @IsString()
  communityId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

@Controller('admin/audit-logs')
@UseGuards(AdminGuard, RolesGuard)
export class AdminAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() query: AuditLogsQuery) {
    return this.audit.list(query);
  }
}
