import { Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ErrorCode } from '@pf/shared';
import { OwnerGuard } from '../auth/owner.guard';
import { BizException } from '../common/biz.exception';

/** 上传根目录：容器内由 UPLOAD_DIR 指定并挂 volume；本地落在 apps/api/uploads */
export const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

function monthDir(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 业主图片上传（报修等场景），≤5MB，jpg/png/webp */
@Controller('owner/upload')
@UseGuards(OwnerGuard)
export class UploadController {
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = path.join(UPLOAD_ROOT, monthDir());
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          cb(null, `${Date.now()}-${randomBytes(6).toString('hex')}${EXT[file.mimetype] ?? ''}`);
        },
      }),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED.has(file.mimetype)) {
          cb(new BizException(ErrorCode.UPLOAD_INVALID, '仅支持 jpg/png/webp'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BizException(ErrorCode.UPLOAD_INVALID, '未收到文件');
    return { url: `/uploads/${monthDir()}/${file.filename}` };
  }
}
