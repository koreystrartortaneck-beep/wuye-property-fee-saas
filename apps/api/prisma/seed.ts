/**
 * 演示数据 seed（幂等，可反复执行）。
 * 数据延续小程序静态原型：云璟公馆 / 林悦 / 8-1-2602 / B2-118。
 * 账号：
 *   平台超管  admin / admin123
 *   云璟物业  yunjing / yunjing123
 *   示例物业  demo / demo123
 * 业主（mock 登录）：code = mock:linyue，手机号 code = phone:13800138000
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function upsertAdmin(username: string, password: string, name: string, role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'STAFF', tenantId: string | null) {
  const passwordHash = await bcrypt.hash(password, 10);
  return prisma.adminUser.upsert({
    where: { username },
    create: { username, passwordHash, name, role, tenantId },
    update: { name, role, tenantId },
  });
}

async function upsertCommunity(tenantId: string, name: string, address: string) {
  const exists = await prisma.community.findFirst({ where: { tenantId, name } });
  if (exists) return exists;
  return prisma.community.create({ data: { tenantId, name, address } });
}

async function upsertHouse(
  tenantId: string,
  communityId: string,
  data: {
    type: 'RESIDENCE' | 'PARKING' | 'SHOP';
    code: string;
    displayName: string;
    building?: string;
    unit?: string;
    room?: string;
    area?: string;
    ownerName?: string;
    ownerPhone?: string;
  },
) {
  return prisma.house.upsert({
    where: { communityId_code: { communityId, code: data.code } },
    create: { tenantId, communityId, ...data },
    update: { ...data },
  });
}

async function upsertRule(
  tenantId: string,
  communityId: string,
  data: {
    name: string;
    houseType: 'RESIDENCE' | 'PARKING' | 'SHOP';
    ruleType: 'AREA_PRICE' | 'FIXED' | 'METER' | 'SHARE' | 'FORMULA';
    params: object;
    period: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
    billDay: number;
    dueDays: number;
  },
) {
  const exists = await prisma.feeRule.findFirst({ where: { tenantId, communityId, name: data.name } });
  if (exists) {
    return prisma.feeRule.update({ where: { id: exists.id }, data: { ...data, params: data.params as never } });
  }
  return prisma.feeRule.create({ data: { tenantId, communityId, ...data, params: data.params as never } });
}

async function main() {
  // 平台超管
  await upsertAdmin('admin', 'admin123', '平台超管', 'SUPER_ADMIN', null);

  // ------- 租户 1：云璟物业 -------
  const yunjing = await prisma.tenant.upsert({
    where: { code: 'yunjing' },
    create: { name: '云璟物业', code: 'yunjing', contactName: '客服中心', contactPhone: '400-800-1234' },
    update: {},
  });
  await upsertAdmin('yunjing', 'yunjing123', '云璟物业管理员', 'TENANT_ADMIN', yunjing.id);

  const gongguan = await upsertCommunity(yunjing.id, '云璟公馆', '云璟大道 88 号');

  await upsertHouse(yunjing.id, gongguan.id, {
    type: 'RESIDENCE', code: '8-1-2601', displayName: '8 栋 1 单元 2601',
    building: '8', unit: '1', room: '2601', area: '110.00', ownerName: '王强', ownerPhone: '13800138001',
  });
  await upsertHouse(yunjing.id, gongguan.id, {
    type: 'RESIDENCE', code: '8-1-2602', displayName: '8 栋 1 单元 2602',
    building: '8', unit: '1', room: '2602', area: '128.00', ownerName: '林悦', ownerPhone: '13800138000',
  });
  await upsertHouse(yunjing.id, gongguan.id, {
    type: 'RESIDENCE', code: '3-2-1201', displayName: '3 栋 2 单元 1201',
    building: '3', unit: '2', room: '1201', area: '89.50', ownerName: '林悦', ownerPhone: '13800138000',
  });
  await upsertHouse(yunjing.id, gongguan.id, {
    type: 'PARKING', code: 'B2-118', displayName: 'B2 层固定车位 118',
    area: undefined, ownerName: '林悦', ownerPhone: '13800138000',
  });

  await upsertRule(yunjing.id, gongguan.id, {
    name: '物业管理费', houseType: 'RESIDENCE', ruleType: 'AREA_PRICE',
    params: { unitPrice: 15 }, period: 'MONTHLY', billDay: 1, dueDays: 15,
  });
  await upsertRule(yunjing.id, gongguan.id, {
    name: '车位管理费', houseType: 'PARKING', ruleType: 'FIXED',
    params: { amount: 360 }, period: 'MONTHLY', billDay: 1, dueDays: 15,
  });
  await upsertRule(yunjing.id, gongguan.id, {
    name: '水费', houseType: 'RESIDENCE', ruleType: 'METER',
    params: { unitPrice: 3.5, meterType: 'WATER' }, period: 'MONTHLY', billDay: 5, dueDays: 10,
  });
  const shareRule = await upsertRule(yunjing.id, gongguan.id, {
    name: '公共能耗分摊', houseType: 'RESIDENCE', ruleType: 'SHARE',
    params: { shareBy: 'AREA' }, period: 'MONTHLY', billDay: 1, dueDays: 15,
  });

  // 本月公摊池（演示用）
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  await prisma.sharePool.upsert({
    where: { ruleId_period: { ruleId: shareRule.id, period } },
    create: { tenantId: yunjing.id, ruleId: shareRule.id, period, totalAmount: '529.28' },
    update: {},
  });

  // ------- 租户 2：示例物业（验证多租户隔离） -------
  const demo = await prisma.tenant.upsert({
    where: { code: 'demo' },
    create: { name: '示例物业', code: 'demo' },
    update: {},
  });
  await upsertAdmin('demo', 'demo123', '示例物业管理员', 'TENANT_ADMIN', demo.id);
  const demoCommunity = await upsertCommunity(demo.id, '示例小区', '示例路 1 号');
  await upsertHouse(demo.id, demoCommunity.id, {
    type: 'RESIDENCE', code: '1-1-101', displayName: '1 栋 1 单元 101',
    area: '75.00', ownerName: '演示业主', ownerPhone: '13900000000',
  });
  await upsertRule(demo.id, demoCommunity.id, {
    name: '物业管理费', houseType: 'RESIDENCE', ruleType: 'AREA_PRICE',
    params: { unitPrice: 1.8 }, period: 'MONTHLY', billDay: 1, dueDays: 20,
  });

  console.log('✅ seed 完成');
  console.log('   平台超管: admin / admin123');
  console.log('   云璟物业: yunjing / yunjing123');
  console.log('   示例物业: demo / demo123');
  console.log('   业主 mock 登录 code: mock:linyue，手机号 code: phone:13800138000');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
