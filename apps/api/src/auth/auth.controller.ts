import { Body, Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, maskPhone } from './auth.service';
import { Current, CurrentOwner } from './current.decorator';
import { OwnerGuard } from './owner.guard';

class WxLoginDto {
  @IsString()
  @IsNotEmpty()
  code!: string;
}

class PhoneDto {
  @IsString()
  @IsNotEmpty()
  code!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

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
