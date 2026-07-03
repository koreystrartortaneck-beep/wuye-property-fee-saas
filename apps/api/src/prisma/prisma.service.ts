import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 服务。
 * - `raw`：未加租户过滤的原始 client（seed / 跨租户流程 / 测试专用）
 * - 租户隔离扩展在 T5 中通过 `tenant()` 提供
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /** 原始 client 别名，语义化标注"我明确要绕过租户隔离" */
  get raw(): PrismaClient {
    return this;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
