import { Controller, Headers, Post } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 一次性灰度联调引导端点（无 WebShell 时用）。
 * 以 JWT_SECRET 作为调用口令（x-bootstrap-token 头必须等于 JWT_SECRET），
 * 幂等创建：港城物业 / 金港城 / 测试房屋(业主手机号) / 1 分钱账单 / 租户管理员。
 * 联调完成后应移除本模块。
 */
const PHONE = '18722961375';
const ADMIN_USER = 'gangcheng';
const ADMIN_PW = 'GangCheng2026';

@Controller('ops/pilot-bootstrap')
export class PilotBootstrapController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  async run(@Headers('x-bootstrap-token') token?: string) {
    const expected = process.env.JWT_SECRET || '';
    if (!expected || !token || token !== expected) {
      throw new BizException(ErrorCode.NOT_FOUND); // 不暴露端点存在
    }
    const p = this.prisma.raw;

    let tenant = await p.tenant.findUnique({ where: { code: 'gangcheng' } });
    if (!tenant) {
      tenant = await p.tenant.create({
        data: { name: '港城物业', code: 'gangcheng', contactName: '物业客服', contactPhone: PHONE },
      });
    }
    let community = await p.community.findFirst({ where: { tenantId: tenant.id, name: '金港城' } });
    if (!community) {
      community = await p.community.create({
        data: { tenantId: tenant.id, name: '金港城', address: '金港城小区', servicePhone: PHONE },
      });
    }
    let house = await p.house.findFirst({
      where: { tenantId: tenant.id, communityId: community.id, code: 'JGC-1-101' },
    });
    if (!house) {
      house = await p.house.create({
        data: {
          tenantId: tenant.id, communityId: community.id, code: 'JGC-1-101',
          displayName: '1 栋 1 单元 101', ownerName: '测试业主', ownerPhone: PHONE,
          type: 'RESIDENCE', area: '88.00',
        },
      });
    }
    let bill = await p.bill.findFirst({
      where: { tenantId: tenant.id, houseId: house.id, period: '2026-07', title: '物业费（联调测试）' },
    });
    if (!bill) {
      bill = await p.bill.create({
        data: {
          tenantId: tenant.id, communityId: community.id, houseId: house.id,
          period: '2026-07', title: '物业费（联调测试）', amount: '0.01',
          dueDate: new Date(Date.now() + 30 * 86400000), status: 'UNPAID', source: 'IMPORT', snapshot: {},
        },
      });
    }
    const hash = await bcrypt.hash(ADMIN_PW, 10);
    const existing = await p.adminUser.findUnique({ where: { username: ADMIN_USER } });
    if (existing) {
      await p.adminUser.update({
        where: { username: ADMIN_USER },
        data: { passwordHash: hash, status: 'ACTIVE', mustChangePassword: false, tenantId: tenant.id, role: 'TENANT_ADMIN', tokenVersion: { increment: 1 } },
      });
    } else {
      await p.adminUser.create({
        data: { username: ADMIN_USER, passwordHash: hash, name: '港城物业管理员', role: 'TENANT_ADMIN', tenantId: tenant.id, mustChangePassword: false },
      });
    }

    const scopeTenant = process.env.WX_PAY_ALLOWED_TENANT_ID || null;
    const scopeCommunity = process.env.WX_PAY_ALLOWED_COMMUNITY_ID || null;

    return {
      tenantId: tenant.id,
      communityId: community.id,
      adminUser: ADMIN_USER,
      adminPassword: ADMIN_PW,
      billId: bill.id,
      ownerPhone: PHONE,
      // 支付商户范围自检：两项都为 true 才能付款
      payScope: {
        tenantEnvSet: scopeTenant !== null,
        communityEnvSet: scopeCommunity !== null,
        tenantMatches: scopeTenant === tenant.id,
        communityMatches: scopeCommunity === community.id,
        ready: scopeTenant === tenant.id && scopeCommunity === community.id,
      },
    };
  }
}
