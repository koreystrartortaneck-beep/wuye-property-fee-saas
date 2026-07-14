import { ElMessage } from 'element-plus';
import { store } from './store';

/** API 前缀：dev 走 Vite 代理 /api/v1；生产可由 VITE_API_BASE 覆盖（如 /wuye/api/v1） */
const API_BASE = (import.meta as any).env?.VITE_API_BASE || '/api/v1';

/**
 * 统一 API 封装。
 * - 注入 Bearer token；SUPER_ADMIN 切换租户时注入 X-Tenant-Id
 * - code!==0：toast 错误并抛出；40100：清登录态跳登录页
 */
export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; silent?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (store.token) headers.Authorization = `Bearer ${store.token}`;
  if (store.profile?.role === 'SUPER_ADMIN' && store.actingTenantId) {
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
  if (!options.silent) ElMessage.error(json.message || '请求失败');
  throw Object.assign(new Error(json.message), { code: json.code });
}

/** 上传单张图片到 /admin/upload，返回服务器相对 URL */
export async function uploadImage(file: File): Promise<string> {
  const headers: Record<string, string> = {};
  if (store.token) headers.Authorization = `Bearer ${store.token}`;
  if (store.profile?.role === 'SUPER_ADMIN' && store.actingTenantId) {
    headers['X-Tenant-Id'] = store.actingTenantId;
  }
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/admin/upload`, { method: 'POST', headers, body: form });
  const json = await res.json();
  if (json.code === 0) return json.data.url as string;
  ElMessage.error(json.message || '上传失败');
  throw new Error(json.message);
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
