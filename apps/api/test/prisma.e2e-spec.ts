import { PrismaService } from '../src/prisma/prisma.service';

describe('Prisma 连接与模型（真库）', () => {
  const prisma = new PrismaService();

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { code: 'test-conn' } });
    await prisma.$disconnect();
  });

  it('可建可查 Tenant', async () => {
    await prisma.tenant.deleteMany({ where: { code: 'test-conn' } });
    const t = await prisma.tenant.create({ data: { name: '连接测试', code: 'test-conn' } });
    const found = await prisma.tenant.findUnique({ where: { code: 'test-conn' } });
    expect(found?.id).toBe(t.id);
  });
});
