import { Body, Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, maskPhone } from './auth.service';
import { Current, CurrentOwner } from './current.decorator';
import { OwnerGuard } from './owner.guard';
import { RateLimit } from '../common/rate-limit.guard';

class WxLoginDto {
  @IsString()
  @MaxLength(64)
  @IsNotEmpty()
  code!: string;
}

class PhoneDto {
  @IsString()
  @MaxLength(64)
  @IsNotEmpty()
  code!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  /*
   * 每次调用都会向微信 jscode2session 外呼。配额是按小程序算的，刷爆之后所有业主都
   * 登录不了。20 次/分钟对正常业主绝对够（登录是进入小程序时一次），对刷量远远不够。
   */
  @RateLimit({ limit: 20, windowMs: 60_000, message: '登录请求过于频繁，请稍后再试' })
  @Post('wx-login')
  wxLogin(
    @Body() dto: WxLoginDto,
    @Headers('x-wx-openid') wxOpenid?: string,
    @Headers('x-wx-source') wxSource?: string,
    @Headers('x-wx-appid') wxAppid?: string,
    @Headers('x-authmethod') authMethod?: string,
  ) {
    const cloudRuntime = !!process.env.WX_CLOUD_ENV;
    const trustedCloudRequest =
      cloudRuntime &&
      (wxSource === 'wx_client' || wxSource === 'wx_devtools' || authMethod === 'WX_SERVER_AUTH');
    let trustedOpenid: string | undefined;
    if (trustedCloudRequest) {
      const expectedAppid = process.env.WX_APPID || '';
      if (!expectedAppid || !wxAppid || wxAppid !== expectedAppid) {
        throw new BizException(ErrorCode.UNAUTHORIZED, '小程序 AppID 不匹配');
      }
      trustedOpenid = wxOpenid || undefined;
    }
    return this.auth.wxLogin(dto.code, trustedOpenid);
  }

  // 手机号授权同样外呼微信，且它是绑定房屋的前置步骤，正常业主一辈子点几次
  @RateLimit({ limit: 10, windowMs: 60_000, message: '获取手机号过于频繁，请稍后再试' })
  @Post('phone')
  @UseGuards(OwnerGuard)
  phone(@Current() cur: CurrentOwner, @Body() dto: PhoneDto) {
    return this.auth.bindPhone(cur.ownerId, dto.code);
  }

  @Get('me')
  @UseGuards(OwnerGuard)
  async me(@Current() cur: CurrentOwner) {
    const user = await this.prisma.raw.wxUser.findUnique({ where: { id: cur.ownerId } });
    return { id: user?.id, phone: maskPhone(user?.phone), hasPhone: !!user?.phone };
  }
}
