import { Prisma, PrismaClient } from '@prisma/client';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { getTenantContext } from './tenant-cls';

/** 受租户隔离约束的模型（带 tenantId 列） */
export const TENANT_MODELS = new Set([
  'Community',
  'House',
  'HouseBinding',
  'FeeRule',
  'MeterReading',
  'SharePool',
  'BillRun',
  'Bill',
  'Payment',
  'NotifyLog',
]);

/** 无上下文时读操作使用的不可能命中的租户值 */
const NONE = '__none__';

const CREATE_OPS = new Set(['create', 'createMany']);
const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);
const WRITE_OPS = new Set(['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert']);

function injectData(data: unknown, tenantId: string): unknown {
  if (Array.isArray(data)) return data.map((d) => ({ ...(d as object), tenantId }));
  return { ...(data as object), tenantId };
}

/**
 * 为 PrismaClient 加租户自动过滤：
 * - 查询/更新/删除：where 自动 AND {tenantId}（Prisma 5+ 的 where 允许唯一键旁携带普通字段）
 * - 创建：data 自动写入 tenantId
 * - 上下文缺失：读 → 空结果；写 → 抛 FORBIDDEN
 * - runWithTenant(null)（超管平台视角）与非租户模型不做处理
 */
export function createTenantedClient(client: PrismaClient) {
  return client.$extends(
    Prisma.defineExtension({
      name: 'tenant-isolation',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (!model || !TENANT_MODELS.has(model)) return query(args);

            const ctx = getTenantContext();

            if (!ctx.set) {
              if (WRITE_OPS.has(operation)) {
                throw new BizException(ErrorCode.FORBIDDEN, '缺少租户上下文');
              }
              // 读：强制空结果
              const a = args as { where?: Record<string, unknown> };
              a.where = { ...(a.where ?? {}), tenantId: NONE };
              return query(args);
            }

            if (ctx.tenantId === null) return query(args); // 超管视角

            const tenantId = ctx.tenantId;
            const a = args as {
              where?: Record<string, unknown>;
              data?: unknown;
              create?: Record<string, unknown>;
            };

            if (CREATE_OPS.has(operation)) {
              a.data = injectData(a.data, tenantId);
              return query(args);
            }
            if (operation === 'upsert') {
              a.where = { ...(a.where ?? {}), tenantId };
              a.create = { ...(a.create ?? {}), tenantId };
              return query(args);
            }
            if (WHERE_OPS.has(operation)) {
              a.where = { ...(a.where ?? {}), tenantId };
              return query(args);
            }
            return query(args);
          },
        },
      },
    }),
  );
}

export type TenantedClient = ReturnType<typeof createTenantedClient>;
