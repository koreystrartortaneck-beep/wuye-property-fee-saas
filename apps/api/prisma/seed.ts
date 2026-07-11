/**
 * 演示数据 seed（幂等，可反复执行）。
 * 数据延续小程序静态原型：九紫莲花城 / 林悦 / 8-1-2602 / B2-118。
 * 账号：
 *   平台超管  admin / admin123
 *   九紫物业  yunjing / yunjing123
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

  // ------- 租户 1：九紫物业 -------
  const yunjing = await prisma.tenant.upsert({
    where: { code: 'yunjing' },
    create: { name: '九紫物业', code: 'yunjing', contactName: '客服中心', contactPhone: '400-800-1234' },
    update: {},
  });
  await upsertAdmin('yunjing', 'yunjing123', '九紫物业管理员', 'TENANT_ADMIN', yunjing.id);

  const gongguan = await upsertCommunity(yunjing.id, '九紫莲花城', '莲花大道 9 号');
  await prisma.community.update({ where: { id: gongguan.id }, data: { servicePhone: '400-800-1234' } });

  // 演示公告（幂等：同名存在则跳过）
  const annExists = await prisma.announcement.findFirst({ where: { tenantId: yunjing.id, title: '关于小区消防演练的通知' } });
  if (!annExists) {
    await prisma.announcement.create({
      data: {
        tenantId: yunjing.id,
        communityId: gongguan.id,
        title: '关于小区消防演练的通知',
        content: '各位业主：\n本周六上午 10:00 将在小区中心广场进行消防演练，届时会有警报声与烟雾，请勿惊慌。\n演练期间请配合物业工作人员引导，感谢您的支持。\n\n九紫物业服务中心',
        pinned: true,
      },
    });
  }

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

  // ------- 九紫物业第二楼盘：莲花半岛（体现一司多盘） -------
  const feicui = await upsertCommunity(yunjing.id, '莲花半岛', '半岛路 66 号');
  await upsertHouse(yunjing.id, feicui.id, {
    type: 'RESIDENCE', code: '5-2-1801', displayName: '5 栋 2 单元 1801',
    building: '5', unit: '2', room: '1801', area: '143.60', ownerName: '林悦', ownerPhone: '13800138000',
  });
  await upsertHouse(yunjing.id, feicui.id, {
    type: 'RESIDENCE', code: '5-2-1802', displayName: '5 栋 2 单元 1802',
    area: '98.20', ownerName: '周明', ownerPhone: '13800138002',
  });
  await upsertRule(yunjing.id, feicui.id, {
    name: '物业管理费', houseType: 'RESIDENCE', ruleType: 'AREA_PRICE',
    params: { unitPrice: 8.8 }, period: 'MONTHLY', billDay: 1, dueDays: 20,
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

  // ------- 三期演示数据：工作照片墙 / 生活服务 / 卡券（幂等） -------
  if (!(await prisma.workLog.findFirst({ where: { tenantId: yunjing.id, title: '早班消防巡检' } }))) {
    await prisma.workLog.create({
      data: {
        tenantId: yunjing.id, communityId: gongguan.id, category: 'INSPECTION', title: '早班消防巡检',
        description: '对 8 栋楼道消防栓、灭火器逐层检查，均在有效期内。', staffName: '安保 王队',
        images: ['/uploads/demo/inspect1.jpg', '/uploads/demo/inspect2.jpg'],
      },
    });
    await prisma.workLog.create({
      data: {
        tenantId: yunjing.id, communityId: gongguan.id, category: 'GREENING', title: '中心花园修剪',
        description: '完成中心花园绿篱修剪与浇灌。', staffName: '绿化 李师傅',
        images: ['/uploads/demo/green1.jpg'],
      },
    });
  }
  if (!(await prisma.serviceItem.findFirst({ where: { tenantId: yunjing.id, name: '日常保洁' } }))) {
    await prisma.serviceItem.create({ data: { tenantId: yunjing.id, communityId: gongguan.id, name: '日常保洁', category: '保洁', price: '60.00', unit: '元/时段', description: '专业保洁 2 小时上门，含厨卫深度清洁', sortOrder: 1 } });
    await prisma.serviceItem.create({ data: { tenantId: yunjing.id, communityId: gongguan.id, name: '油烟机清洗', category: '清洗', price: '80.00', unit: '元/台', description: '拆洗油烟机，恢复吸力', sortOrder: 2 } });
    await prisma.serviceItem.create({ data: { tenantId: yunjing.id, communityId: gongguan.id, name: '窗帘清洗', category: '清洗', price: '30.00', unit: '元/米', description: '上门取送，专业清洗', sortOrder: 3 } });
  }
  if (!(await prisma.coupon.findFirst({ where: { tenantId: yunjing.id, name: '物业费满500减20' } }))) {
    await prisma.coupon.create({
      data: {
        tenantId: yunjing.id, communityId: gongguan.id, name: '物业费满500减20', type: 'DISCOUNT',
        faceValue: '20.00', threshold: '500.00', description: '缴纳物业费满 500 元可用，每户限领 1 张',
        totalQty: 200, perUserLimit: 1, validFrom: new Date('2026-01-01'), validTo: new Date('2026-12-31T23:59:59'),
      },
    });
    await prisma.coupon.create({
      data: {
        tenantId: yunjing.id, communityId: null, name: '报修免上门费券', type: 'SERVICE',
        description: '有偿维修时可免除上门费', totalQty: 500, perUserLimit: 2,
        validFrom: new Date('2026-01-01'), validTo: new Date('2026-12-31T23:59:59'),
      },
    });
  }

  console.log('✅ seed 完成');
  console.log('   平台超管: admin / admin123');
  console.log('   九紫物业: yunjing / yunjing123');
  console.log('   示例物业: demo / demo123');
  console.log('   业主 mock 登录 code: mock:linyue，手机号 code: phone:13800138000');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
