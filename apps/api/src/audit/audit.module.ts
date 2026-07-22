import { Global, Module } from '@nestjs/common';
import { IdempotencyService } from '../common/idempotency.service';
import { AdminAuditController } from './admin-audit.controller';
import { AuditService } from './audit.service';

@Global()
@Module({
  controllers: [AdminAuditController],
  providers: [AuditService, IdempotencyService],
  exports: [AuditService, IdempotencyService],
})
export class AuditModule {}
