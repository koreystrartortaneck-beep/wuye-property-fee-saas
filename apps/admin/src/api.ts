import { ElMessage } from 'element-plus';
import { store } from './store';

/** 平台角色：不属于任何租户，可通过 X-Tenant-Id 切换视角 */
export function isPlatformRole(role?: string): boolean {
  return role === 'SUPER_ADMIN' || role === 'PLATFORM_READONLY';
}

/** 只读平台角色：后端拒绝它的一切非 GET 请求，前端据此隐藏写操作 */
export function isReadonlyRole(role?: string): boolean {
  return role === 'PLATFORM_READONLY';
}

/** API 前缀：dev 走 Vite 代理 /api/v1；生产可由 VITE_API_BASE 覆盖（如 /wuye/api/v1） */
const API_BASE = (import.meta as any).env?.VITE_API_BASE || '/api/v1';

/**
 * 统一 API 封装。
 * - 注入 Bearer token；平台角色（SUPER_ADMIN / PLATFORM_READONLY）切换租户时注入
 *   X-Tenant-Id。只读角色也要带：运营数据是租户内的（后端 requireTenant 会拒绝
 *   无租户视角的请求），不带的话只读账号打不开运维页。
 * - code!==0：toast 错误并抛出；40100：清登录态跳登录页
 */
export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; silent?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (store.token) headers.Authorization = `Bearer ${store.token}`;
  if (isPlatformRole(store.profile?.role) && store.actingTenantId) {
    headers['X-Tenant-Id'] = store.actingTenantId;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const json = await res.json();

  if (json.code === 0) return json.data as T;
  if (json.code === 40100) {
    store.logout();
    location.hash = '#/login';
  }
  if (json.code === 40401) {
    /*
     * 选中的物业公司已不存在（被删除，或本地缓存过期）。
     *
     * 必须在这里自动清掉并回到平台视角 —— 否则会锁死：
     * 租户列表接口也带 X-Tenant-Id，它同样失败的话，操作者没有任何入口换回去，
     * 只能手工清 localStorage。
     */
    store.setActingTenant('');
    ElMessage.warning(json.message || '所选物业公司不存在，已切回平台视角');
    location.reload();
    throw Object.assign(new Error(json.message), { code: json.code });
  }
  if (!options.silent) ElMessage.error(json.message || '请求失败');
  throw Object.assign(new Error(json.message), { code: json.code });
}

/**
 * 上传单张图片到 /admin/upload。
 *
 * 返回 { url, viewUrl }：url 是入库标识（cloud:// 或 /uploads/...），
 * viewUrl 是可直接渲染的临时地址 —— 用它预览刚上传的图，
 * 不要再回头调 /admin/cloud-files/urls：那个端点按「fileID 必须已存在于本租户记录中」
 * 校验归属，而此刻这张图还没保存。
 */
export async function uploadImage(file: File): Promise<{ url: string; viewUrl: string }> {
  const headers: Record<string, string> = {};
  if (store.token) headers.Authorization = `Bearer ${store.token}`;
  if (isPlatformRole(store.profile?.role) && store.actingTenantId) {
    headers['X-Tenant-Id'] = store.actingTenantId;
  }
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/admin/upload`, { method: 'POST', headers, body: form });
  const json = await res.json();
  if (json.code === 0) {
    const data = json.data as { url: string; viewUrl?: string };
    // 自建部署没有 viewUrl 字段（返回的就是可直接访问的相对路径）
    return { url: data.url, viewUrl: data.viewUrl || data.url };
  }
  ElMessage.error(json.message || '上传失败');
  throw new Error(json.message);
}

/**
 * 上传文件 + 附带表单字段到指定路径（multipart/form-data），返回业务 data。
 * 用于账单导入预览/确认等既有文件又有字段的接口。code!==0 时 toast 并抛错。
 */
export async function uploadForm<T = unknown>(
  path: string,
  file: File,
  fields: Record<string, string | undefined> = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (store.token) headers.Authorization = `Bearer ${store.token}`;
  if (isPlatformRole(store.profile?.role) && store.actingTenantId) {
    headers['X-Tenant-Id'] = store.actingTenantId;
  }
  const form = new FormData();
  form.append('file', file);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') form.append(k, v);
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: form });
  const json = await res.json();
  if (json.code === 0) return json.data as T;
  if (json.code === 40100) {
    store.logout();
    location.hash = '#/login';
  }
  ElMessage.error(json.message || '上传失败');
  throw Object.assign(new Error(json.message), { code: json.code });
}

/** 图片相对路径 → 可访问 URL（dev 走代理，生产走 VITE_API_BASE 同源） */
export function imgUrl(rel: string): string {
  if (!rel) return '';
  if (rel.startsWith('http')) return rel;
  // cloud:// 需异步解析成临时 URL（见 useCloudImages），此处不直接拼，避免生成坏地址
  if (rel.startsWith('cloud://')) return '';
  return API_BASE.replace(/\/api\/v1$/, '') + rel;
}

export interface Page<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 拼查询串，忽略空值 */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
