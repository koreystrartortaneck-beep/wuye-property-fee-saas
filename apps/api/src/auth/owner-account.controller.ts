import { Controller, Delete, UseGuards } from '@nestjs/common';
import { Current, CurrentOwner } from './current.decorator';
import { OwnerAccountService } from './owner-account.service';
import { OwnerGuard } from './owner.guard';

/** 业主账号：注销（匿名化 + 吊销令牌 + 解绑，保留财务/审计留痕）。 */
@Controller('owner/account')
@UseGuards(OwnerGuard)
export class OwnerAccountController {
  constructor(private readonly service: OwnerAccountService) {}

  @Delete()
  remove(@Current() cur: CurrentOwner) {
    return this.service.deleteAccount(cur.ownerId);
  }
}
