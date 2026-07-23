import { Body, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { BillImportService } from './bill-import.service';

const ALLOWED_IMPORT = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

export const importUploadOptions = {
  storage: memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req: unknown, file: Express.Multer.File, cb: (e: Error | null, ok: boolean) => void) => {
    const name = file.originalname.toLowerCase();
    if (!name.endsWith('.csv') && !name.endsWith('.xlsx')) {
      cb(new BizException(ErrorCode.UPLOAD_INVALID, '仅支持 .csv 或 .xlsx'), false);
      return;
    }
    if (!ALLOWED_IMPORT.has(file.mimetype)) {
      cb(new BizException(ErrorCode.UPLOAD_INVALID, '文件类型不符合要求'), false);
      return;
    }
    cb(null, true);
  },
};

class ImportDto {
  @IsString()
  @IsNotEmpty()
  communityId!: string;

  @IsString()
  @IsNotEmpty()
  period!: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  requestId?: string;
}

@Controller('admin/bill-imports')
@UseGuards(AdminGuard, RolesGuard)
export class BillImportController {
  constructor(private readonly service: BillImportService) {}

  @Post('preview')
  @UseInterceptors(FileInterceptor('file', importUploadOptions))
  preview(@Current() cur: CurrentAdmin, @UploadedFile() file: Express.Multer.File | undefined, @Body() dto: ImportDto) {
    if (!file) throw new BizException(ErrorCode.UPLOAD_INVALID, '未收到文件');
    return this.service.preview({
      communityId: dto.communityId,
      period: dto.period,
      title: dto.title,
      fileName: file.originalname,
      buffer: file.buffer,
      adminId: cur.adminId,
      actingTenantId: cur.tenantId,
    });
  }

  @Post('confirm')
  @UseInterceptors(FileInterceptor('file', importUploadOptions))
  confirm(@Current() cur: CurrentAdmin, @UploadedFile() file: Express.Multer.File | undefined, @Body() dto: ImportDto) {
    if (!file) throw new BizException(ErrorCode.UPLOAD_INVALID, '未收到文件');
    return this.service.confirm({
      communityId: dto.communityId,
      period: dto.period,
      title: dto.title,
      fileName: file.originalname,
      buffer: file.buffer,
      adminId: cur.adminId,
      actingTenantId: cur.tenantId,
      requestId: dto.requestId,
    });
  }
}
