import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Current, CurrentOwner } from '../auth/current.decorator';
import { OwnerGuard } from '../auth/owner.guard';
import { PageQuery } from '../common/pagination';
import { RateLimit } from '../common/rate-limit.guard';
import { CouponsService } from './coupons.service';

@Controller('owner')
@UseGuards(OwnerGuard)
export class OwnerCouponsController {
  constructor(private readonly service: CouponsService) {}

  @Get('coupons')
  available(@Current() cur: CurrentOwner, @Query('houseId') houseId: string) {
    return this.service.available(cur.ownerId, houseId);
  }

  /*
   * 领券要限流：每次都写库并生成核销码，而限领的硬保证虽在数据库
   * （唯一约束会挡住超发），但一个脚本连打几百次仍会白占库存名额、
   * 刷掉别人能领的份额 —— 券是有限的，抢光就是别人领不到。
   * 60/分钟对正常人绝对够（正常是点一次），对脚本足够窄。
   */
  @RateLimit({ limit: 60, windowMs: 60_000, message: '领取过于频繁，请稍后再试' })
  @Post('coupons/:id/claim')
  claim(@Current() cur: CurrentOwner, @Param('id') id: string) {
    return this.service.claim(cur.ownerId, id);
  }

  @Get('my/coupons')
  mine(@Current() cur: CurrentOwner, @Query() q: PageQuery) {
    return this.service.myCoupons(cur.ownerId, q);
  }

  /*
   * 亮码核销的二维码(2026-08-13,物业拍板:券到前台兑奖品,员工扫码核销)。
   * 服务端生成而不是小程序里手搓 QR 算法 —— 编码矩阵错一位就是扫不出来,
   * 用成熟库。限流:图是算出来的(CPU),不该被脚本白嫖。
   */
  @RateLimit({ limit: 30, windowMs: 60_000, message: '请求过于频繁，请稍后再试' })
  @Get('my/coupons/:id/qr')
  qr(@Current() cur: CurrentOwner, @Param('id') id: string) {
    return this.service.myCouponQr(cur.ownerId, id);
  }
}
