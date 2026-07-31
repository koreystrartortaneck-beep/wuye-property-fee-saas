import { Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage, memoryStorage } from 'multer';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { OwnerGuard } from '../auth/owner.guard';
import { BizException } from '../common/biz.exception';
import { signUploadUrl } from './upload-access';
import { WxCloudService } from '../wx/wx-cloud.service';
import { RateLimit } from '../common/rate-limit.guard';

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

/**
 * 文件魔数（前几个字节）。
 *
 * fileFilter 里判的是 multipart 头里客户端**自己声明**的 Content-Type，
 * 而扩展名又是从这个声明映射来的——也就是说磁盘上可以躺着任意内容的 .jpg。
 * 当前靠「扩展名决定响应 Content-Type」阻断了 XSS 执行，但配合无鉴权的
 * /uploads 静态目录，这实际上是一个免费的匿名文件寄存服务（可被用来托管违法内容，
 * 而责任归属在部署方）。所以落盘后按真实字节再验一次。
 */
const MAGIC: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: 'image/webp',
    test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

/** 落盘后校验真实字节；不匹配即删除并拒绝 */
function assertRealImage(file: Express.Multer.File): void {
  let head: Buffer;
  try {
    const fd = fs.openSync(file.path, 'r');
    head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    fs.closeSync(fd);
  } catch {
    throw new BizException(ErrorCode.UPLOAD_INVALID, '文件读取失败，请重试');
  }
  if (!MAGIC.some((m) => m.test(head))) {
    // 不留下不合规的文件
    try {
      fs.unlinkSync(file.path);
    } catch {
      /* 删不掉也要拒绝 */
    }
    throw new BizException(ErrorCode.UPLOAD_INVALID, '文件内容不是有效的 jpg/png/webp 图片');
  }
}

/**
 * 测试专用引用。
 * assertRealImage 走的是「落盘后按真实字节校验，不合规则删除」这条路径，删文件的逻辑
 * 必须用行为测试证明范围正确，而它没有独立的 HTTP 入口可打。
 */
export const __test_assertRealImage = assertRealImage;

function toResult(file?: Express.Multer.File) {
  if (!file) throw new BizException(ErrorCode.UPLOAD_INVALID, '未收到文件');
  assertRealImage(file);
  /*
   * url 返回**裸路径**，viewUrl 返回带签名的即时可用地址。
   *
   * 这个区分是必须的：url 会被前端存进 Ticket.images / WorkLog.images，而签名只有
   * 10 分钟有效 —— 把带签名的地址存进库，10 分钟后所有历史图片全部打不开。
   * 签名要在**读取时**按当次请求现签（见 signUploadPaths），存的必须是裸路径。
   *
   * viewUrl 供上传后立刻预览用（此时签名还新鲜），不入库。
   */
  const pathname = `/uploads/${monthDir()}/${file.filename}`;
  return { url: pathname, viewUrl: signUploadUrl(pathname) };
}

/** 云存储上传用：把文件读进内存（不落盘），再转存微信云存储 */
export const memUploadOptions = {
  storage: memoryStorage(),
  limits: uploadOptions.limits,
  fileFilter: uploadOptions.fileFilter,
};

/** 业主图片上传（报修等场景） */
@Controller('owner/upload')
@UseGuards(OwnerGuard)
export class UploadController {
  /*
   * 每次最多 5MB 落盘，而上传目录与 MySQL 共享宿主磁盘 —— 磁盘打满两个一起挂。
   * 20 张/分钟：业主报修一次贴几张图，够用；想把磁盘写满则远远不够。
   */
  @RateLimit({ limit: 20, windowMs: 60_000, message: '上传过于频繁，请稍后再试' })
  @Post()
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  upload(@UploadedFile() file?: Express.Multer.File) {
    return toResult(file);
  }
}

/** 管理端图片上传（照片墙、服务封面等场景）。
 *  云模式下转存微信云存储返回 cloud:// fileID，保证业主小程序真机也能显示；
 *  未配置云环境时回退磁盘。 */
@Controller('admin/upload')
@UseGuards(AdminGuard)
export class AdminUploadController {
  constructor(private readonly wxCloud: WxCloudService) {}

  // 管理端批量传照片墙时会连发，阈值放宽一些
  @RateLimit({ limit: 60, windowMs: 60_000, message: '上传过于频繁，请稍后再试' })
  @Post()
  @UseInterceptors(FileInterceptor('file', process.env.WX_CLOUD_ENV ? memUploadOptions : uploadOptions))
  async upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BizException(ErrorCode.UPLOAD_INVALID, '未收到文件');
    if (process.env.WX_CLOUD_ENV) {
      const ext = EXT[file.mimetype] ?? '.jpg';
      const cloudPath = `admin/${monthDir()}/${Date.now()}-${randomBytes(6).toString('hex')}${ext}`;
      const fileId = await this.wxCloud.uploadToCloud(cloudPath, file.buffer, file.mimetype);
      return { url: fileId };
    }
    return toResult(file);
  }
}
