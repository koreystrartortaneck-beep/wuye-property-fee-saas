import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
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
  constructor(private readonly auth: AuthService) {}

  @Post('wx-login')
  wxLogin(@Body() dto: WxLoginDto) {
    return this.auth.wxLogin(dto.code);
  }

  @Post('phone')
  @UseGuards(OwnerGuard)
  phone(@Current() cur: CurrentOwner, @Body() dto: PhoneDto) {
    return this.auth.bindPhone(cur.ownerId, dto.code);
  }
}
