import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { setupApp } from './setup-app';
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
  // 上传图片静态托管（生产由 Nginx /wuye/uploads/ 反代到这里）
  app.useStaticAssets(UPLOAD_ROOT, { prefix: '/uploads/' });
  await app.listen(process.env.PORT ?? 3000);
  // eslint-disable-next-line no-console
  console.log(`API listening on :${process.env.PORT ?? 3000}`);
}

void bootstrap();
