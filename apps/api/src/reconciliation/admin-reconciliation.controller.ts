import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { RECONCILIATION_BILL_TYPES, ReconciliationBillType } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { ReconciliationService } from './reconciliation.service';
import { BizException } from '../common/biz.exception';
import { ErrorCode } from '@pf/shared';

/**
 * 对账用的商户参数来源：与每日 runDaily 完全一致的那三个环境变量。
 * 单独抽出来，避免两处读法漂移（cron 用一套、手动触发用另一套就会出现
 * 「自动对账正常、手动对账报商户不匹配」这种极难排查的情况）。
 */
function merchantFromEnv() {
  return {
    merchantAccountId: process.env.WX_PAY_MERCHANT_SERIAL,
    mchid: process.env.WX_PAY_MCH_ID,
    appid: process.env.WX_PAY_APP_ID ?? process.env.WX_APPID,
  };
}

class TriggerReconcileDto {
  /*
   * 三个商户参数改为可选，缺省时由服务端从环境变量取。
   *
   * 原先是必填，而物业**无从知道**这三个值：它们只存在于服务端环境变量里，
   * merchantAccountId 实际上是商户 API 证书的序列号（一串十六进制），
   * 后台界面上没有任何地方能查到。于是「手动对账」这个功能事实上不可用——
   * 而每日 02:00 的 runDaily 恰恰是从同一批环境变量读的
   * （WX_PAY_MERCHANT_SERIAL / WX_PAY_MCH_ID / WX_PAY_APP_ID），
   * 说明服务端本来就知道，只是没告诉这个端点。
   *
   * 保留可选传入：超管为另一个商户号补跑历史账期时仍可显式指定。
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  merchantAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  mchid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  appid?: string;

  @IsOptional()
  @IsString()
  communityId?: string;

  @Type(() => Date)
  @IsDate()
  businessDate!: Date;

  @IsIn(RECONCILIATION_BILL_TYPES as unknown as string[])
  billType!: ReconciliationBillType;

  /**
   * 强制重跑已完成的账期。用于修正历史上用错误解析逻辑跑出的对账结果。
   * 会删除该批次尚未处置的差异项，保留已人工处置的。
   */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

class ResolveItemDto {
  @IsIn(['MANUALLY_CLOSED', 'ESCALATED'])
  status!: 'MANUALLY_CLOSED' | 'ESCALATED';

  @IsOptional()
  @IsString()
  @MaxLength(191)
  remark?: string;
}

function isoDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

@Injectable()
export class AdminReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async listRuns(q: PageQuery) {
    const [list, total] = await Promise.all([
      this.prisma.t.reconciliationRun.findMany({ ...pageArgs(q), orderBy: { startedAt: 'desc' } }),
      this.prisma.t.reconciliationRun.count(),
    ]);
    return pageResult(list, total, q);
  }

  async listItems(runId: string, q: PageQuery) {
    const where = { runId };
    const [list, total] = await Promise.all([
      this.prisma.t.reconciliationItem.findMany({ where, ...pageArgs(q), orderBy: { createdAt: 'desc' } }),
      this.prisma.t.reconciliationItem.count({ where }),
    ]);
    return pageResult(list, total, q);
  }
}

@Controller('admin/reconciliations')
@UseGuards(AdminGuard, RolesGuard)
export class AdminReconciliationController {
  constructor(
    private readonly service: ReconciliationService,
    private readonly read: AdminReconciliationService,
  ) {}

  @Get()
  listRuns(@Query() q: PageQuery) {
    return this.read.listRuns(q);
  }

  @Get(':runId/items')
  listItems(@Param('runId') runId: string, @Query() q: PageQuery) {
    return this.read.listItems(runId, q);
  }

  /**
   * 当前配置的对账商户（脱敏）。
   * 让界面能显示「将用商户 16xxxx89 对账」而不是要求物业自己输一串证书序列号。
   */
  @Get('config')
  config() {
    const m = merchantFromEnv();
    const mask = (v?: string) => (v && v.length > 6 ? `${v.slice(0, 2)}****${v.slice(-4)}` : v ?? '');
    return {
      configured: !!(m.merchantAccountId && m.mchid && m.appid),
      mchid: mask(m.mchid),
      appid: mask(m.appid),
      merchantAccountId: mask(m.merchantAccountId),
    };
  }

  @Post()
  trigger(@Current() cur: CurrentAdmin, @Body() dto: TriggerReconcileDto) {
    const env = merchantFromEnv();
    const merchantAccountId = dto.merchantAccountId ?? env.merchantAccountId;
    const mchid = dto.mchid ?? env.mchid;
    const appid = dto.appid ?? env.appid;
    if (!merchantAccountId || !mchid || !appid) {
      throw new BizException(
        ErrorCode.VALIDATION,
        '服务端未配置微信支付商户参数，无法对账。请在云托管环境变量里设置 ' +
          'WX_PAY_MERCHANT_SERIAL / WX_PAY_MCH_ID / WX_PAY_APP_ID 后重试。',
      );
    }
    return this.service.reconcile({
      tenantId: cur.tenantId as string,
      communityId: dto.communityId ?? null,
      merchantAccountId,
      force: dto.force ?? false,
      mchid,
      appid,
      businessDate: isoDate(dto.businessDate),
      billType: dto.billType,
      adminId: cur.adminId,
    });
  }

  @Post('items/:itemId/resolve')
  resolve(@Current() cur: CurrentAdmin, @Param('itemId') itemId: string, @Body() dto: ResolveItemDto) {
    return this.service.resolveItem({
      itemId,
      adminId: cur.adminId,
      actingTenantId: cur.tenantId,
      status: dto.status,
      remark: dto.remark,
    });
  }
}
