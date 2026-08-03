import { Body, Controller, Get, Injectable, Put, UseGuards } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { Roles, RolesGuard } from '../auth/roles.decorator';
import { AuditService } from '../audit/audit.service';
import { BindingSyncService, DEFAULT_BINDING_CONFIG } from '../binding/binding-sync.service';
import { PrismaService } from '../prisma/prisma.service';

/*
 * 绑定渠道开关(租户级)。开新楼盘时按需启停,不改代码:
 *   phoneMatch             关 → 授权手机号不再自动匹配房屋
 *   selfApply              关 → 小程序隐藏申请入口,POST /owner/bindings 直接拒绝
 *   selfApplyNeedsApproval 关 → 申请即生效(直接 ACTIVE)
 * 服务端强制;小程序 UI 只是跟着显隐(载体:GET /owner/communities)。
 */

class UpdateBindingConfigDto {
  @IsBoolean()
  phoneMatch!: boolean;

  @IsBoolean()
  selfApply!: boolean;

  @IsBoolean()
  selfApplyNeedsApproval!: boolean;
}

@Injectable()
export class BindingConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bindingSync: BindingSyncService,
    private readonly audit: AuditService,
  ) {}

  get(tenantId: string) {
    return this.bindingSync.getConfig(tenantId);
  }

  async update(tenantId: string, dto: UpdateBindingConfigDto, adminId: string) {
    const before = await this.bindingSync.getConfig(tenantId);
    const row = await this.prisma.raw.tenantBindingConfig.upsert({
      where: { tenantId },
      create: { tenantId, ...dto, changedBy: adminId },
      update: { ...dto, changedBy: adminId },
    });
    /*
     * 渠道开关是权限面的变更(关掉 phoneMatch 意味着后面所有授权都匹配不上),
     * 必须留痕,且 before/after 都记 —— 排查「业主说绑不上」时第一个看这里。
     */
    await this.audit.append({
      tenantId,
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'UPDATE',
      resourceType: 'TenantBindingConfig',
      resourceId: row.id,
      beforeSummary: { ...before },
      afterSummary: { event: 'BINDING_CONFIG_UPDATE', ...dto },
    });
    return this.bindingSync.getConfig(tenantId);
  }
}

@Controller('admin/binding-config')
@UseGuards(AdminGuard, RolesGuard)
export class BindingConfigController {
  constructor(private readonly service: BindingConfigService) {}

  @Get()
  get(@Current() cur: CurrentAdmin) {
    // defaults 一并返回,前端能标出「当前是默认配置」
    return this.service.get(cur.tenantId!).then((config) => ({ config, defaults: DEFAULT_BINDING_CONFIG }));
  }

  /*
   * 与解除绑定同级:关一个开关等于改变所有业主的进入路径,
   * 限定 TENANT_ADMIN(RolesGuard 对没标 @Roles 的写端点默认放行所有管理员)。
   */
  @Roles('TENANT_ADMIN')
  @Put()
  update(@Current() cur: CurrentAdmin, @Body() dto: UpdateBindingConfigDto) {
    return this.service.update(cur.tenantId!, dto, cur.adminId);
  }
}
