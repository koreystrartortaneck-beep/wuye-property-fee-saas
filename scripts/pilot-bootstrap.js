/* 单小区灰度联调引导（在云托管「云端调试」容器内运行；幂等可重跑）。
 * 建：租户 港城物业 / 小区 金港城 / 测试房屋(业主手机号=测试号) / 1 分钱账单 / 租户管理员。
 * 打印：WX_PAY_ALLOWED_TENANT_ID、WX_PAY_ALLOWED_COMMUNITY_ID、后台账号、billId。 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const p = new PrismaClient();

const PHONE = '18722961375';        // 测试业主手机号（规范化：无 +86）
const ADMIN_USER = 'gangcheng';
const ADMIN_PW = 'GangCheng2026';   // ≥12 位，含字母数字

(async () => {
  // 1) 租户：港城物业
  let tenant = await p.tenant.findUnique({ where: { code: 'gangcheng' } });
  if (!tenant) {
    tenant = await p.tenant.create({
      data: { name: '港城物业', code: 'gangcheng', contactName: '物业客服', contactPhone: PHONE },
    });
  }
  // 2) 小区：金港城
  let community = await p.community.findFirst({ where: { tenantId: tenant.id, name: '金港城' } });
  if (!community) {
    community = await p.community.create({
      data: { tenantId: tenant.id, name: '金港城', address: '金港城小区', servicePhone: PHONE },
    });
  }
  // 3) 测试房屋（业主手机号=测试号，微信授权时自动匹配绑定）
  let house = await p.house.findFirst({ where: { tenantId: tenant.id, communityId: community.id, code: 'JGC-1-101' } });
  if (!house) {
    house = await p.house.create({
      data: {
        tenantId: tenant.id, communityId: community.id, code: 'JGC-1-101',
        displayName: '1 栋 1 单元 101', ownerName: '测试业主', ownerPhone: PHONE,
        type: 'RESIDENCE', area: '88.00',
      },
    });
  }
  // 4) 1 分钱测试账单（UNPAID）
  let bill = await p.bill.findFirst({
    where: { tenantId: tenant.id, houseId: house.id, period: '2026-07', title: '物业费（联调测试）' },
  });
  if (!bill) {
    bill = await p.bill.create({
      data: {
        tenantId: tenant.id, communityId: community.id, houseId: house.id,
        period: '2026-07', title: '物业费（联调测试）', amount: '0.01',
        dueDate: new Date(Date.now() + 30 * 86400000), status: 'UNPAID',
        source: 'IMPORT', snapshot: {},
      },
    });
  }
  // 5) 后台管理员（租户管理员，直接可用；幂等：已存在则重置密码并启用）
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

  console.log('\n========== 联调引导完成 ==========');
  console.log('WX_PAY_ALLOWED_TENANT_ID=' + tenant.id);
  console.log('WX_PAY_ALLOWED_COMMUNITY_ID=' + community.id);
  console.log('后台账号: ' + ADMIN_USER + '  密码: ' + ADMIN_PW);
  console.log('测试账单 billId=' + bill.id + '  金额=0.01  业主手机号=' + PHONE);
  console.log('==================================\n');
  await p.$disconnect();
})().catch((e) => { console.error('BOOTSTRAP FAILED:', e.message); process.exit(1); });
