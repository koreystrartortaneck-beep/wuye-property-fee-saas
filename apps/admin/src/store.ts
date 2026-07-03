import { reactive } from 'vue';

export interface Profile {
  name: string;
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'STAFF';
  tenantId: string | null;
}

/** 轻量登录态（localStorage 持久化），不引状态库 */
export const store = reactive({
  token: localStorage.getItem('pf_admin_token') || '',
  profile: JSON.parse(localStorage.getItem('pf_admin_profile') || 'null') as Profile | null,
  /** 超管视角下当前操作的租户 */
  actingTenantId: localStorage.getItem('pf_acting_tenant') || '',

  login(token: string, profile: Profile) {
    this.token = token;
    this.profile = profile;
    localStorage.setItem('pf_admin_token', token);
    localStorage.setItem('pf_admin_profile', JSON.stringify(profile));
  },

  setActingTenant(id: string) {
    this.actingTenantId = id;
    localStorage.setItem('pf_acting_tenant', id);
  },

  logout() {
    this.token = '';
    this.profile = null;
    this.actingTenantId = '';
    localStorage.removeItem('pf_admin_token');
    localStorage.removeItem('pf_admin_profile');
    localStorage.removeItem('pf_acting_tenant');
  },
});
