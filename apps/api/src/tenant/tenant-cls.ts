import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 租户上下文（AsyncLocalStorage）。
 * - runWithTenant(tenantId, fn)：普通租户视角
 * - runWithTenant(null, fn)：平台超管视角（跨租户，不过滤）
 * - 完全没有上下文：读强制空、写拒绝（见 tenant-extension）
 */
interface TenantStore {
  tenantId: string | null;
}

const als = new AsyncLocalStorage<TenantStore>();

/**
 * 在租户上下文中执行 fn。
 * 注意：Prisma 的查询是惰性 thenable，必须在上下文内完成 await，
 * 因此这里用 async 包裹（内部 await），而非直接返回 fn() 的结果。
 */
export function runWithTenant<T>(tenantId: string | null, fn: () => T | Promise<T>): Promise<T> {
  return als.run({ tenantId }, async () => fn());
}

/**
 * 同步版：在租户上下文中执行 fn 并返回其同步结果。
 * 供拦截器包裹 next.handle().subscribe(...) 使用——
 * 注意不能在 async 守卫里用 enterWith（await 返回后调用方会恢复原上下文）。
 */
export function runWithTenantSync<T>(tenantId: string | null, fn: () => T): T {
  return als.run({ tenantId }, fn);
}

export function getTenantContext(): { set: boolean; tenantId: string | null } {
  const store = als.getStore();
  if (!store) return { set: false, tenantId: null };
  return { set: true, tenantId: store.tenantId };
}
