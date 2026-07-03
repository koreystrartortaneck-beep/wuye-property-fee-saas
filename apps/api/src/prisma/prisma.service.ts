import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createTenantedClient, TenantedClient } from '../tenant/tenant-extension';

/**
 * Prisma 服务。
 * - `t`：租户隔离 client（业务代码默认用它，自动 AND tenantId）
 * - `raw`：未加租户过滤的原始 client（seed / 业主跨租户流程 / 测试专用）
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /** 租户隔离 client（业务代码默认用它） */
  readonly t: TenantedClient;

  /** 原始 client，语义化标注"我明确要绕过租户隔离" */
  readonly raw: PrismaClient;

  constructor() {
    super();
    // 注意：PrismaClient 构造器返回 Proxy，只有构造器内的 this 才是完整代理，
    // getter 中的 this 会指向缺少模型委托的 target —— 因此必须在这里初始化。
    this.raw = this;
    this.t = createTenantedClient(this);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
