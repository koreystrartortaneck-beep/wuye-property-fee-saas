import { Global, Module } from '@nestjs/common';
import { NotifyLogsController } from './notify-logs.controller';
import { NotifyService } from './notify.service';
import { BILL_NOTIFIER } from './notify.tokens';

@Global()
@Module({
  controllers: [NotifyLogsController],
  providers: [NotifyService, { provide: BILL_NOTIFIER, useExisting: NotifyService }],
  exports: [BILL_NOTIFIER],
})
export class NotifyModule {}
