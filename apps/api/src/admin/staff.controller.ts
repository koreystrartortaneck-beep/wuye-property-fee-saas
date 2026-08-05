import { Body, Controller, Get, Injectable, Param, Patch, Post, UseGuards } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { Roles, RolesGuard } from '../auth/roles.decorator';
import { BCRYPT_COST, assertStrongPassword, generateInitialPassword, normalizePhone } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';

/*
 * 员工账号与权限 —— 物业自己管，不用找开发。
 *
 * 为什么必须有:在此之前整个公司只有一个能用的管理账号,而
 * AdminUser.phone 是唯一的 —— 也就是说**只有一个人能用手机进管理端**。
 * 收费员上岗没有入口,离职更没有:他的手机号一直留在名单里,
 * 换了工作照样能看全小区的欠费、给业主退款。
 *
 * 两个角色,差别就一句话:
 *   物业管理员(TENANT_ADMIN) —— 什么都能做,包括退款、整批作废、彻底删房
 *   收费员(STAFF)           —— 日常收钱、催缴、出账、处理报修;动钱的三件事做不了
 * 这不是界面上藏起来,是服务端的 @Roles 在挡(手机端只是顺带不显示死按钮)。
 *
 * 三条把人锁在门外的路,全部堵掉:
 *   · 不能停用/降级自己
 *   · 不能停用/降级最后一个在职管理员
 *   · 不能创建平台级角色(那不属于任何物业公司)
 * 一个公司把自己搞成「没有管理员」,就只能找我改数据库 —— 那种状态不该做得出来。
 */

/** 物业公司自己能设的角色。平台级角色不在这里 —— 它们不属于任何一家公司 */
const TENANT_ROLES = ['TENANT_ADMIN', 'STAFF'] as const;
type TenantRole = (typeof TENANT_ROLES)[number];

class CreateStaffDto {
  /** 登录名:给电脑后台用;手机端免密走手机号 */
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9._-]+$/, { message: '登录名只能用字母、数字和 . _ -' })
  username!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsIn(TENANT_ROLES as unknown as string[])
  role!: TenantRole;

  /** 手机号:填了就能用手机免密进管理端(与电脑后台同一个账号) */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  phone?: string;
}

class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsIn(TENANT_ROLES as unknown as string[])
  role?: TenantRole;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  /** 空字符串 = 摘掉手机号(那个人以后不能再用手机进管理端) */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  phone?: string;
}

const ROLE_LABEL: Record<string, string> = { TENANT_ADMIN: '物业管理员', STAFF: '收费员' };

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private requireTenant(cur: CurrentAdmin): string {
    if (!cur.tenantId) throw new BizException(ErrorCode.FORBIDDEN, '请在具体物业公司下管理员工账号');
    return cur.tenantId;
  }

  /** 只列本公司的账号;手机号只给尾 4 位 —— 名单页不需要全号,泄露面越小越好 */
  async list(cur: CurrentAdmin) {
    const tenantId = this.requireTenant(cur);
    const rows = await this.prisma.raw.adminUser.findMany({
      where: { tenantId, role: { in: [...TENANT_ROLES] } },
      orderBy: [{ status: 'asc' }, { username: 'asc' }],
      select: {
        id: true,
        username: true,
        name: true,
        role: true,
        status: true,
        phone: true,
        mustChangePassword: true,
        lockedUntil: true,
      },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        username: r.username,
        name: r.name,
        role: r.role,
        roleLabel: ROLE_LABEL[r.role] ?? r.role,
        status: r.status,
        phoneTail: r.phone ? r.phone.slice(-4) : null,
        canPhoneLogin: !!r.phone && r.status === 'ACTIVE' && !r.mustChangePassword,
        mustChangePassword: r.mustChangePassword,
        // 连错密码被锁的账号:名单上要看得出来,否则「他说登不上」无从判断
        lockedUntil: r.lockedUntil,
        isSelf: r.id === cur.adminId,
      })),
    };
  }

  private normalizeOptionalPhone(phone?: string): string | null | undefined {
    if (phone === undefined) return undefined;
    if (!phone.trim()) return null;
    const p = normalizePhone(phone);
    if (!/^1[3-9]\d{9}$/.test(p)) throw new BizException(ErrorCode.VALIDATION, '请填写 11 位大陆手机号');
    return p;
  }

  async create(cur: CurrentAdmin, dto: CreateStaffDto) {
    const tenantId = this.requireTenant(cur);
    const exists = await this.prisma.raw.adminUser.findUnique({ where: { username: dto.username } });
    if (exists) throw new BizException(ErrorCode.VALIDATION, `登录名「${dto.username}」已被占用`);
    const phone = this.normalizeOptionalPhone(dto.phone);

    /*
     * 初始密码由服务端生成并**只返回这一次**,且强制首次登录改密。
     * 让创建者自己填密码的话,现实里就是一串「123456」在全公司传。
     */
    const password = generateInitialPassword();
    assertStrongPassword(password);
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    let created;
    try {
      created = await this.prisma.raw.adminUser.create({
        data: {
          tenantId,
          username: dto.username,
          name: dto.name,
          role: dto.role,
          passwordHash,
          phone: phone ?? null,
          mustChangePassword: true,
        },
        select: { id: true, username: true, name: true, role: true },
      });
    } catch (e) {
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
        throw new BizException(ErrorCode.VALIDATION, '这个手机号已经登记在另一个账号上');
      }
      throw e;
    }

    await this.audit.append({
      tenantId,
      actorType: 'ADMIN',
      actorId: cur.adminId,
      action: 'CREATE',
      resourceType: 'AdminUser',
      resourceId: created.id,
      // 键名避开脱敏词表;尾 4 位足以核对是谁的号,全号绝不进审计
      afterSummary: {
        event: 'STAFF_CREATE',
        username: created.username,
        name: created.name,
        role: created.role,
        contactTail: phone ? phone.slice(-4) : null,
      },
    });

    /*
     * 手机号填了但还不能用手机登录 —— 因为 mustChangePassword 为真时
     * /auth/admin-exchange 会拒绝(受限会话)。这句必须说出来,
     * 否则物业会以为「填了号就能进」,然后对着「没有管理权限」猜半天。
     */
    return {
      id: created.id,
      username: created.username,
      password,
      needsFirstLogin: true,
      hint: phone
        ? '请他先在电脑后台用这个初始密码登录一次并改密码,之后手机授权手机号即可免密进入'
        : '请他先在电脑后台用这个初始密码登录一次并改密码',
    };
  }

  async update(cur: CurrentAdmin, id: string, dto: UpdateStaffDto) {
    const tenantId = this.requireTenant(cur);
    const target = await this.prisma.raw.adminUser.findUnique({
      where: { id },
      select: { id: true, tenantId: true, username: true, name: true, role: true, status: true, phone: true },
    });
    if (!target || target.tenantId !== tenantId || !TENANT_ROLES.includes(target.role as TenantRole)) {
      throw new BizException(ErrorCode.NOT_FOUND, '该账号不存在或不属于本物业公司');
    }

    const losingAdmin =
      (dto.status === 'DISABLED' && target.status === 'ACTIVE') ||
      (dto.role === 'STAFF' && target.role === 'TENANT_ADMIN');

    /*
     * 不能把自己停用或降级。
     * 允许的话,一个手滑就把自己关在门外 —— 而恢复需要平台超管,
     * 也就是要来找我。这种「做得出来的死局」不该存在。
     */
    if (losingAdmin && target.id === cur.adminId) {
      throw new BizException(ErrorCode.VALIDATION, '不能停用或降级自己 —— 请让另一位管理员来操作');
    }

    const phone = this.normalizeOptionalPhone(dto.phone);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined && dto.name !== target.name) data.name = dto.name;
    if (dto.role !== undefined && dto.role !== target.role) data.role = dto.role;
    if (dto.status !== undefined && dto.status !== target.status) data.status = dto.status;
    if (phone !== undefined && (phone ?? null) !== (target.phone ?? null)) data.phone = phone;
    if (Object.keys(data).length === 0) return { id: target.id, changed: [] };

    /*
     * 角色或状态一变,就把 tokenVersion 加一 —— 已经发出去的令牌立刻失效。
     * 不这么做的话:刚被降级的收费员手里那张管理员令牌还能用满 12 小时,
     * 而「降级」这个动作在他看来什么也没发生。
     */
    if (data.role !== undefined || data.status !== undefined) {
      data.tokenVersion = { increment: 1 };
    }

    /*
     * 「不能拿掉最后一个在职管理员」这条检查必须与写在同一个事务里,而且要**锁行**。
     *
     * 只 count 一次再写是个真竞态:两位管理员同时停用彼此,两边都看到「还有另一个
     * 在职」,于是双双通过 —— 结果公司里一个管理员都不剩,而恢复要动数据库。
     * SELECT … FOR UPDATE 把「其它在职管理员」那几行锁住:并发的那一方要么等,
     * 要么在锁释放后读到 0 并被拒。
     */
    try {
      await this.prisma.raw.$transaction(async (tx) => {
        if (losingAdmin) {
          const others = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT \`id\` FROM \`AdminUser\`
            WHERE \`tenantId\` = ${tenantId} AND \`role\` = 'TENANT_ADMIN'
              AND \`status\` = 'ACTIVE' AND \`id\` <> ${target.id}
            FOR UPDATE
          `;
          if (others.length === 0) {
            throw new BizException(
              ErrorCode.VALIDATION,
              '这是本公司最后一个在职管理员,不能停用或降级 —— 先设好另一位管理员再来',
            );
          }
        }
        await tx.adminUser.update({ where: { id: target.id }, data });
      });
    } catch (e) {
      if (e instanceof BizException) throw e;
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
        throw new BizException(ErrorCode.VALIDATION, '这个手机号已经登记在另一个账号上');
      }
      throw e;
    }

    const changed: Record<string, unknown> = {};
    if (data.name !== undefined) changed.name = { from: target.name, to: data.name };
    if (data.role !== undefined) changed.role = { from: target.role, to: data.role };
    if (data.status !== undefined) changed.status = { from: target.status, to: data.status };
    if (data.phone !== undefined) {
      changed.contactTail = {
        from: target.phone ? target.phone.slice(-4) : null,
        to: phone ? phone.slice(-4) : null,
      };
    }
    await this.audit.append({
      tenantId,
      actorType: 'ADMIN',
      actorId: cur.adminId,
      action: 'UPDATE',
      resourceType: 'AdminUser',
      resourceId: target.id,
      beforeSummary: { username: target.username, changed },
      afterSummary: { event: 'STAFF_UPDATE', fields: Object.keys(changed) },
    });
    return { id: target.id, changed: Object.keys(changed) };
  }

  /** 重置密码:生成新的一次性口令,并强制他下次登录改掉 */
  async resetPassword(cur: CurrentAdmin, id: string) {
    const tenantId = this.requireTenant(cur);
    const target = await this.prisma.raw.adminUser.findUnique({
      where: { id },
      select: { id: true, tenantId: true, username: true, role: true },
    });
    if (!target || target.tenantId !== tenantId || !TENANT_ROLES.includes(target.role as TenantRole)) {
      throw new BizException(ErrorCode.NOT_FOUND, '该账号不存在或不属于本物业公司');
    }
    const password = generateInitialPassword();
    assertStrongPassword(password);
    await this.prisma.raw.adminUser.update({
      where: { id: target.id },
      data: {
        passwordHash: await bcrypt.hash(password, BCRYPT_COST),
        mustChangePassword: true,
        // 旧令牌立刻失效:重置密码的常见场景是手机丢了或人已离职
        tokenVersion: { increment: 1 },
      },
    });
    await this.audit.append({
      tenantId,
      actorType: 'ADMIN',
      actorId: cur.adminId,
      action: 'UPDATE',
      resourceType: 'AdminUser',
      resourceId: target.id,
      // 口令绝不入审计
      afterSummary: { event: 'STAFF_PASSWORD_RESET', username: target.username },
    });
    return { id: target.id, username: target.username, password, needsFirstLogin: true };
  }
}

@Controller('admin/staff')
@UseGuards(AdminGuard, RolesGuard)
// 整个控制器限管理员:收费员不该能给自己升权,也不该能停用同事
@Roles('TENANT_ADMIN')
export class StaffController {
  constructor(private readonly service: StaffService) {}

  @Get()
  list(@Current() cur: CurrentAdmin) {
    return this.service.list(cur);
  }

  @Post()
  create(@Current() cur: CurrentAdmin, @Body() dto: CreateStaffDto) {
    return this.service.create(cur, dto);
  }

  @Patch(':id')
  update(@Current() cur: CurrentAdmin, @Param('id') id: string, @Body() dto: UpdateStaffDto) {
    return this.service.update(cur, id, dto);
  }

  @Post(':id/reset-password')
  resetPassword(@Current() cur: CurrentAdmin, @Param('id') id: string) {
    return this.service.resetPassword(cur, id);
  }
}
