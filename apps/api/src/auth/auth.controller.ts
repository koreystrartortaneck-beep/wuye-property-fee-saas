import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
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
  wxLogin(@Body() dto: WxLoginDto) {
    return this.auth.wxLogin(dto.code);
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
    return { id: user?.id, phone: user?.phone ?? null, hasPhone: !!user?.phone };
  }
}
