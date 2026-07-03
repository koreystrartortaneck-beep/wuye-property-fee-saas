import { Body, Controller, Get, Injectable, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { AuthService } from '../auth/auth.service';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';

class AdminLoginDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async login(username: string, password: string) {
    const admin = await this.prisma.raw.adminUser.findUnique({ where: { username } });
    if (!admin || admin.status !== 'ACTIVE' || !(await bcrypt.compare(password, admin.passwordHash))) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '用户名或密码错误');
    }
    const token = await this.auth.signAdminToken({
      sub: admin.id,
      tenantId: admin.tenantId,
      role: admin.role,
    });
    return { token, profile: { name: admin.name, role: admin.role, tenantId: admin.tenantId } };
  }
}

@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly service: AdminAuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('login')
  login(@Body() dto: AdminLoginDto) {
    return this.service.login(dto.username, dto.password);
  }

  @Get('profile')
  @UseGuards(AdminGuard)
  async profile(@Current() cur: CurrentAdmin) {
    const admin = await this.prisma.raw.adminUser.findUnique({ where: { id: cur.adminId } });
    return { name: admin?.name, role: cur.role, tenantId: cur.tenantId };
  }
}
