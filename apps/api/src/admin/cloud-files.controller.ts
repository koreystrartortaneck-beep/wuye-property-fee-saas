import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { Roles, RolesGuard } from '../auth/roles.decorator';
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

/** 后台把业主上传的 cloud:// 工单图片解析成浏览器可访问的临时 URL */
/*
 * 这个端点把任意 cloud:// fileID 换成可访问的临时 URL，而且不校验该文件是否属于本租户
 * ——同一云环境下别的业务的文件也能被解析。它服务的是「后台查看业主上传的工单图片」，
 * 属于日常运营动作，所以限到 STAFF 及以上而不是超管；同时补了数量上限与频率限制。
 * 归属校验（fileID 必须出现在本租户的 Ticket.images / WorkLog.images 里）留待后续，
 * 需要先把 images 的存储格式统一。
 */
@Controller('admin/cloud-files')
@UseGuards(AdminGuard, RolesGuard)
@Roles('STAFF', 'TENANT_ADMIN')
export class CloudFilesController {
  constructor(private readonly wxCloud: WxCloudService) {}

  // 每次向微信换一批 2 小时有效的下载链接；一个页面打开时批量解析一次就够
  @RateLimit({ limit: 60, windowMs: 60_000 })
  @Post('urls')
  async urls(@Body() dto: ResolveDto): Promise<Record<string, string>> {
    return this.wxCloud.resolveFileUrls(dto.fileIds);
  }
}
