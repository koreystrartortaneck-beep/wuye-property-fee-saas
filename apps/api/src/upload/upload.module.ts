import { Module } from '@nestjs/common';
import { AdminUploadController, UploadController } from './upload.controller';

@Module({
  controllers: [UploadController, AdminUploadController],
})
export class UploadModule {}
