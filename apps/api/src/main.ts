import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { setupApp } from './setup-app';
import { UPLOAD_ROOT } from './upload/upload.controller';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  setupApp(app);
  // 上传图片静态托管（生产由 Nginx /wuye/uploads/ 反代到这里）
  app.useStaticAssets(UPLOAD_ROOT, { prefix: '/uploads/' });
  await app.listen(process.env.PORT ?? 3000);
  // eslint-disable-next-line no-console
  console.log(`API listening on :${process.env.PORT ?? 3000}`);
}

void bootstrap();
