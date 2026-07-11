import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Current, CurrentOwner } from '../auth/current.decorator';
import { OwnerGuard } from '../auth/owner.guard';
import { PageQuery } from '../common/pagination';
import { CouponsService } from './coupons.service';

@Controller('owner')
@UseGuards(OwnerGuard)
export class OwnerCouponsController {
  constructor(private readonly service: CouponsService) {}

  @Get('coupons')
  available(@Current() cur: CurrentOwner, @Query('houseId') houseId: string) {
    return this.service.available(cur.ownerId, houseId);
  }

  @Post('coupons/:id/claim')
  claim(@Current() cur: CurrentOwner, @Param('id') id: string) {
    return this.service.claim(cur.ownerId, id);
  }

  @Get('my/coupons')
  mine(@Current() cur: CurrentOwner, @Query() q: PageQuery) {
    return this.service.myCoupons(cur.ownerId, q);
  }
}
