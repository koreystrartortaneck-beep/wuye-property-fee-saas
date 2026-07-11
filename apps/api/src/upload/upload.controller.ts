import { Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
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

/** 业主 / 管理端共用的 multer 配置（≤5MB，jpg/png/webp，按月分目录） */
export const uploadOptions = {
  storage: diskStorage({
    destination: (_req: unknown, _file: unknown, cb: (e: Error | null, dir: string) => void) => {
      const dir = path.join(UPLOAD_ROOT, monthDir());
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req: unknown, file: Express.Multer.File, cb: (e: Error | null, name: string) => void) => {
      cb(null, `${Date.now()}-${randomBytes(6).toString('hex')}${EXT[file.mimetype] ?? ''}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req: unknown, file: Express.Multer.File, cb: (e: Error | null, ok: boolean) => void) => {
    if (!ALLOWED.has(file.mimetype)) {
      cb(new BizException(ErrorCode.UPLOAD_INVALID, '仅支持 jpg/png/webp'), false);
      return;
    }
    cb(null, true);
  },
};

function toResult(file?: Express.Multer.File) {
  if (!file) throw new BizException(ErrorCode.UPLOAD_INVALID, '未收到文件');
  return { url: `/uploads/${monthDir()}/${file.filename}` };
}

/** 业主图片上传（报修等场景） */
@Controller('owner/upload')
@UseGuards(OwnerGuard)
export class UploadController {
  @Post()
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  upload(@UploadedFile() file?: Express.Multer.File) {
    return toResult(file);
  }
}

/** 管理端图片上传（照片墙、服务封面等场景） */
@Controller('admin/upload')
@UseGuards(AdminGuard)
export class AdminUploadController {
  @Post()
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  upload(@UploadedFile() file?: Express.Multer.File) {
    return toResult(file);
  }
}
