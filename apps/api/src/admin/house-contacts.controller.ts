import { Body, Controller, Delete, Get, Injectable, Param, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { normalizePhone } from '../auth/auth.service';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { BindingSyncService } from '../binding/binding-sync.service';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';

/*
 * 房屋授权手机号(联系人)管理 —— 换租/换房主的主操作面。
 *
 *   换租 = 删旧号 + 加新号,两步十秒。
 *   加号 = 授权:该号的微信用户当场绑上(已授权过手机号的)或下次授权即绑。
 *   删号 = 解绑:同一事务里撤销该房该号的全部生效绑定 ——
 *          这是本次重构修的核心 bug:原来后台改手机号完全不触碰绑定,
 *          前住户换租后继续看得到现住户的账单。
 *
 * 不做删前确认(产品决策),但删了什么必须如实返回:响应带 revokedBindings。
 */

class AddContactDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;
}

@Injectable()
export class HouseContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bindingSync: BindingSyncService,
  ) {}

  /** 房屋必须属于当前租户;顺带取审计需要的小区/房号 */
  private async loadHouse(houseId: string) {
    const house = await this.prisma.t.house.findFirst({
      where: { id: houseId },
      select: { id: true, tenantId: true, communityId: true, code: true, displayName: true },
    });
    if (!house) throw new BizException(ErrorCode.NOT_FOUND, '房屋不存在或不属于当前物业公司');
    return house;
  }

  async list(houseId: string) {
    const house = await this.loadHouse(houseId);
    const contacts = await this.prisma.t.houseContact.findMany({
      where: { houseId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, phone: true, name: true, source: true, createdAt: true },
    });
    /*
     * 每个号是否已经有人在用 —— 物业最关心的是「加了号之后他绑上了没有」。
     * 按 wxUser.phone 反查生效绑定,一次查询,行数 = 联系人数,极小。
     */
    const activeBindings = await this.prisma.raw.houseBinding.findMany({
      where: { houseId, status: 'ACTIVE' },
      select: { wxUser: { select: { phone: true } } },
    });
    const boundPhones = new Set(activeBindings.map((b) => b.wxUser.phone).filter(Boolean));
    return {
      house: { id: house.id, code: house.code, displayName: house.displayName },
      items: contacts.map((c) => ({ ...c, bound: boundPhones.has(c.phone) })),
    };
  }

  async add(houseId: string, dto: AddContactDto, adminId: string) {
    const house = await this.loadHouse(houseId);
    const phone = normalizePhone(dto.phone);
    this.bindingSync.assertMobile(phone);

    const result = await this.prisma.raw.$transaction((tx) =>
      this.bindingSync.grantContact(tx, house, phone, dto.name?.trim() || null, 'ADMIN', {
        type: 'ADMIN',
        id: adminId,
      }),
    );
    if (!result.created) {
      throw new BizException(ErrorCode.VALIDATION, '该房屋已登记此手机号');
    }
    return { contactId: result.contactId, activatedBindings: result.activatedBindings };
  }

  async remove(contactId: string, adminId: string) {
    const contact = await this.prisma.t.houseContact.findFirst({
      where: { id: contactId },
      select: { id: true, houseId: true, phone: true },
    });
    if (!contact) throw new BizException(ErrorCode.NOT_FOUND, '联系人不存在或不属于当前物业公司');
    const house = await this.loadHouse(contact.houseId);

    const result = await this.prisma.raw.$transaction((tx) =>
      this.bindingSync.revokeContact(tx, house, contact.phone, '物业已移除该房屋的联系人授权', {
        type: 'ADMIN',
        id: adminId,
      }),
    );
    return { deleted: true, revokedBindings: result.revoked };
  }
}

@Controller('admin')
@UseGuards(AdminGuard, RolesGuard)
export class HouseContactsController {
  constructor(private readonly service: HouseContactsService) {}

  @Get('houses/:id/contacts')
  list(@Param('id') houseId: string) {
    return this.service.list(houseId);
  }

  @Post('houses/:id/contacts')
  add(@Current() cur: CurrentAdmin, @Param('id') houseId: string, @Body() dto: AddContactDto) {
    return this.service.add(houseId, dto, cur.adminId);
  }

  @Delete('house-contacts/:id')
  remove(@Current() cur: CurrentAdmin, @Param('id') id: string) {
    return this.service.remove(id, cur.adminId);
  }
}
