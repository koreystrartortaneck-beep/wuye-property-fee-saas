import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { Roles, RolesGuard } from '../auth/roles.decorator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantContext } from '../tenant/tenant-cls';
import { WxCloudService } from '../wx/wx-cloud.service';
import { RateLimit } from '../common/rate-limit.guard';

class ResolveDto {
  /*
   * 数量上限。原先只有 @IsArray()，可以一次塞进任意多个 fileID，
   * 每个都要向微信换一次 2 小时有效的下载链接。
   * 50 个覆盖一屏工单图片（每单最多几张）。
   */
  @IsArray()
  @ArrayMaxSize(50, { message: '单次最多解析 50 个文件' })
  @IsString({ each: true })
  fileIds: string[] = [];
}

/**
 * 后台把 cloud:// 图片解析成浏览器可访问的临时 URL。
 *
 * 归属校验：fileID 必须已经出现在**本租户**的记录里
 * （Ticket.images / WorkLog.images / ServiceItem.coverImage）。
 *
 * 不校验的话，任何 STAFF 都能把任意 fileID 换成可下载的临时链接 ——
 * 同一云环境下别的物业公司的业主报修照片（可能拍到户内、门牌、身份材料）
 * 只要知道 fileID 就能取到。fileID 不易猜（时间戳 + 6 字节随机），
 * 但「不易猜」不是授权。
 *
 * 这条校验此前被记为「留待后续，需要先统一 images 的存储格式」。
 * 重新核对后那个理由不成立：两个 images 字段都是 Json 字符串数组，coverImage 是字符串列，
 * 三处形状明确、可直接查。
 *
 * 刚上传还没保存的图不会被这里拒掉 —— /admin/upload 现在一并返回 viewUrl，
 * 前端用它预览，不再回头解析（否则管理员看不到自己刚传的图）。
 */
@Controller('admin/cloud-files')
@UseGuards(AdminGuard, RolesGuard)
@Roles('STAFF', 'TENANT_ADMIN')
export class CloudFilesController {
  constructor(
    private readonly wxCloud: WxCloudService,
    private readonly prisma: PrismaService,
  ) {}

  // 每次向微信换一批 2 小时有效的下载链接；一个页面打开时批量解析一次就够
  @RateLimit({ limit: 60, windowMs: 60_000 })
  @Post('urls')
  async urls(@Body() dto: ResolveDto): Promise<Record<string, string>> {
    const ids = [...new Set(dto.fileIds.filter((x) => typeof x === 'string' && x))];
    if (ids.length === 0) return {};
    const allowed = await this.ownedFileIds(ids);
    /*
     * 未授权的 id 直接不出现在结果里，而不是抛错。
     *
     * 一屏图片里混进一个已被删除记录的旧 fileID 是正常的（记录删了、id 还在前端缓存里），
     * 整批抛错会让整页图片都打不开。前端对缺失的 key 已经按「图裂」处理。
     */
    return this.wxCloud.resolveFileUrls(ids.filter((id) => allowed.has(id)));
  }

  /**
   * 这批 fileID 里哪些确实属于本租户。
   *
   * 用 JSON_TABLE 把 Json 数组展开成行再取交集（MySQL 8.0.4+，本仓已在迁移里用过窗口函数，
   * 版本前提一致）。逐个 JSON_CONTAINS 也能做，但那是 50 × 2 次查询。
   */
  private async ownedFileIds(ids: string[]): Promise<Set<string>> {
    const ctx = getTenantContext();
    /*
     * 没有租户上下文时一律不授权（fail closed）。
     * 管理端路由都会被 TenantContextInterceptor 设上，走到这里说明装配出了问题 ——
     * 那种情况下宁可图片打不开，也不要把校验降级成放行。
     */
    if (!ctx.set) return new Set();

    /*
     * 平台视角（超管未选租户）：不限定租户，但仍要求 fileID **存在于某个租户的记录里**。
     * 这既不挡住平台运维查图，又挡住了「同一云环境下别的应用的文件」——
     * 那才是这个端点最初的敞口。
     */
    const list = Prisma.join(ids);
    const tenantId = ctx.tenantId;
    const scope = (col: string) =>
      tenantId === null ? Prisma.sql`1 = 1` : Prisma.sql`${Prisma.raw(col)} = ${tenantId}`;
    const rows = await this.prisma.raw.$queryRaw<Array<{ fileId: string }>>(Prisma.sql`
      SELECT DISTINCT jt.v AS fileId
      FROM \`Ticket\` t,
           JSON_TABLE(t.images, '$[*]' COLUMNS (v VARCHAR(512) PATH '$')) jt
      WHERE ${scope('t.tenantId')} AND jt.v IN (${list})
      UNION
      SELECT DISTINCT jt.v AS fileId
      FROM \`WorkLog\` w,
           JSON_TABLE(w.images, '$[*]' COLUMNS (v VARCHAR(512) PATH '$')) jt
      WHERE ${scope('w.tenantId')} AND jt.v IN (${list})
      UNION
      SELECT DISTINCT s.coverImage AS fileId
      FROM \`ServiceItem\` s
      WHERE ${scope('s.tenantId')} AND s.coverImage IN (${list})
    `);
    return new Set(rows.map((r) => r.fileId));
  }
}
