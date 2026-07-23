import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsOptional, IsString } from 'class-validator';
import { COLLECTION_POLICY_STATUSES, CollectionPolicyStatus, ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { Roles, RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { CollectionPolicyService } from './collection-policy.service';

class UpdatePolicyDto {
  @IsIn(COLLECTION_POLICY_STATUSES as unknown as string[])
  status!: CollectionPolicyStatus;

  @IsString()
  reason!: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  resumeAt?: Date;
}

/**
 * 分层暂停收款管理端。
 * - 平台层：仅 SUPER_ADMIN；
 * - 租户/小区层：任意在职物业管理员即视为确认（单人操作，全员财务权限策略）。
 */
@Controller('admin/collection-policies')
@UseGuards(AdminGuard, RolesGuard)
export class AdminCollectionController {
  constructor(private readonly service: CollectionPolicyService) {}

  private tenantOf(cur: CurrentAdmin): string {
    if (!cur.tenantId) throw new BizException(ErrorCode.FORBIDDEN, '请在具体租户视角下操作收款策略');
    return cur.tenantId;
  }

  @Get()
  get(@Current() cur: CurrentAdmin) {
    return this.service.getPolicies(this.tenantOf(cur));
  }

  @Put('platform')
  @Roles('SUPER_ADMIN')
  updatePlatform(@Current() cur: CurrentAdmin, @Body() dto: UpdatePolicyDto) {
    return this.service.setPlatformPolicy({
      adminId: cur.adminId,
      status: dto.status,
      reason: dto.reason,
      resumeAt: dto.resumeAt ?? null,
    });
  }

  @Put('tenant')
  updateTenant(@Current() cur: CurrentAdmin, @Body() dto: UpdatePolicyDto) {
    return this.service.setTenantPolicy({
      tenantId: this.tenantOf(cur),
      adminId: cur.adminId,
      status: dto.status,
      reason: dto.reason,
      resumeAt: dto.resumeAt ?? null,
    });
  }

  @Put('community/:communityId')
  updateCommunity(
    @Current() cur: CurrentAdmin,
    @Param('communityId') communityId: string,
    @Body() dto: UpdatePolicyDto,
  ) {
    return this.service.setCommunityPolicy({
      tenantId: this.tenantOf(cur),
      communityId,
      adminId: cur.adminId,
      status: dto.status,
      reason: dto.reason,
      resumeAt: dto.resumeAt ?? null,
    });
  }
}
