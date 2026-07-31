import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { setupApp } from './setup-app';
import { verifyUploadToken } from './upload/upload-access';

/** 静态目录中间件用到的最小请求/响应形状 */
interface UploadReq {
  path: string;
  query?: { exp?: unknown; sig?: unknown };
}
interface UploadRes {
  status(code: number): { json(body: unknown): void };
}
import { UPLOAD_ROOT } from './upload/upload.controller';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  /*
   * 信任一层反向代理，让 req.ip 取到真实客户端 IP。
   *
   * 不开时 req.ip 是 socket 对端地址，也就是 nginx / 云托管网关（常见 127.0.0.1）。
   * 后果是双向的：
   *   · 登录限流失效——所有来源共用同一个计数桶，攻击者无法被区分；
   *   · 更糟的是它变成一个 DoS：IP_MAX 是 30 次/分钟且**全世界共用**，
   *     任何人每分钟发 31 个登录请求，就能让所有管理员在该窗口内一律被拒。
   * nginx 侧已设 X-Forwarded-For（deploy/nginx-wuye.locations），云托管网关同样会带。
   * 取 1 而不是 true：只信任最靠近应用的那一跳，避免客户端自己伪造一长串 XFF。
   */
  app.set('trust proxy', 1);
  setupApp(app);
  /*
   * 上传图片静态托管（生产由 Nginx /wuye/uploads/ 反代到这里）。
   *
   * 挂静态目录之前先校验签名：这个目录原本**完全无鉴权**，而业主报修照片可能拍到
   * 户内、门牌、身份材料，只靠「时间戳 + 6 字节随机」的文件名保护——48 位熵不可暴力
   * 枚举，但 URL 一旦经 referrer、截图、日志、转发外泄就长期有效且无法吊销。
   *
   * 用 query 里的签名而不是 Guard：图片走 <img src> 加载，浏览器不带 Authorization 头。
   * 生产配了 WX_CLOUD_ENV、图片走微信云存储的临时 URL，不经这条路径；
   * 这里保护的是自建部署（docker-compose.prod.yml 那套）的回退路径。
   */
  app.use('/uploads', (req: UploadReq, res: UploadRes, next: () => void) => {
    try {
      // req.path 在这个中间件里是去掉 /uploads 前缀后的部分，签名按完整路径算
      verifyUploadToken(`/uploads${req.path}`, req.query?.exp, req.query?.sig);
      next();
    } catch (e) {
      res.status(403).json({ code: 40300, message: e instanceof Error ? e.message : '禁止访问' });
    }
  });
  app.useStaticAssets(UPLOAD_ROOT, { prefix: '/uploads/' });
  await app.listen(process.env.PORT ?? 3000);
  // eslint-disable-next-line no-console
  console.log(`API listening on :${process.env.PORT ?? 3000}`);
}

void bootstrap();
