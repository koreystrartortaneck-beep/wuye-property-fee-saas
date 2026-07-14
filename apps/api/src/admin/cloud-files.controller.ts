import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsString } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { WxCloudService } from '../wx/wx-cloud.service';

class ResolveDto {
  @IsArray()
  @IsString({ each: true })
  fileIds: string[] = [];
}

/** 后台把业主上传的 cloud:// 工单图片解析成浏览器可访问的临时 URL */
@Controller('admin/cloud-files')
@UseGuards(AdminGuard)
export class CloudFilesController {
  constructor(private readonly wxCloud: WxCloudService) {}

  @Post('urls')
  async urls(@Body() dto: ResolveDto): Promise<Record<string, string>> {
    return this.wxCloud.resolveFileUrls(dto.fileIds);
  }
}
