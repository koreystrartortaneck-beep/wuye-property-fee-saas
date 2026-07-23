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
  'BillBatch',
  'Payment',
  'Refund',
  'RefundAttempt',
  'ReconciliationRun',
  'ReconciliationItem',
  'AuditLog',
  'PaymentEvent',
  'IdempotencyRecord',
  'OutboxEvent',
  'InvoiceApplication',
  'TenantCollectionPolicy',
  'CommunityCollectionPolicy',
  'NotifyLog',
  'Ticket',
  'VisitorPass',
  'Announcement',
  'WorkLog',
  'ServiceItem',
  'ServiceOrder',
  'Coupon',
  'UserCoupon',
  'OperationalAlert',
  'AlertAttempt',
  'Incident',
]);

/** 无上下文时读操作使用的不可能命中的租户值 */
const NONE = '__none__';

const CREATE_OPS = new Set(['create', 'createMany']);
const UPDATE_OPS = new Set(['update', 'updateMany']);
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
const SUPPORTED_OPS = new Set([...CREATE_OPS, ...WHERE_OPS, 'upsert']);

function injectData(data: unknown, tenantId: string): unknown {
  if (Array.isArray(data)) return data.map((d) => ({ ...(d as object), tenantId }));
  return { ...(data as object), tenantId };
}

/**
 * 为 PrismaClient 加租户自动过滤：
 * - 查询/更新/删除：where 自动 AND {tenantId}（Prisma 5+ 的 where 允许唯一键旁携带普通字段）
 * - 创建：data 自动写入 tenantId
 * - 上下文缺失：读 → 空结果；写 → 抛 FORBIDDEN
 * - runWithTenant(null) 仅放开租户模型的跨租户视角；平台模型必须使用 raw client
 * - 非租户模型与未知操作默认拒绝
 */
export function createTenantedClient(client: PrismaClient) {
  return client.$extends(
    Prisma.defineExtension({
      name: 'tenant-isolation',
      query: {
        async $queryRaw() {
          throw new BizException(ErrorCode.FORBIDDEN, '租户客户端禁止原始数据库操作');
        },
        async $queryRawUnsafe() {
          throw new BizException(ErrorCode.FORBIDDEN, '租户客户端禁止原始数据库操作');
        },
        async $executeRaw() {
          throw new BizException(ErrorCode.FORBIDDEN, '租户客户端禁止原始数据库操作');
        },
        async $executeRawUnsafe() {
          throw new BizException(ErrorCode.FORBIDDEN, '租户客户端禁止原始数据库操作');
        },
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (!model || !TENANT_MODELS.has(model)) {
              throw new BizException(ErrorCode.FORBIDDEN, '租户客户端禁止访问非租户模型');
            }
            if (!SUPPORTED_OPS.has(operation)) {
              throw new BizException(ErrorCode.FORBIDDEN, '租户客户端禁止未知数据库操作');
            }

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
              update?: Record<string, unknown>;
            };

            if (CREATE_OPS.has(operation)) {
              a.data = injectData(a.data, tenantId);
              return query(args);
            }
            if (operation === 'upsert') {
              a.where = { ...(a.where ?? {}), tenantId };
              a.create = injectData(a.create, tenantId) as Record<string, unknown>;
              a.update = injectData(a.update, tenantId) as Record<string, unknown>;
              return query(args);
            }
            if (WHERE_OPS.has(operation)) {
              a.where = { ...(a.where ?? {}), tenantId };
              if (UPDATE_OPS.has(operation)) {
                a.data = injectData(a.data, tenantId);
              }
              return query(args);
            }
            throw new BizException(ErrorCode.FORBIDDEN, '租户客户端禁止未知数据库操作');
          },
        },
      },
    }),
  );
}

export type TenantedClient = ReturnType<typeof createTenantedClient>;
