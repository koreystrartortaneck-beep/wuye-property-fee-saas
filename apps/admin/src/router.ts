/*
 * 路由不再携带 meta.title。
 *
 * 这些标题从来没有显示过：页面标题取自 nav.ts 的 locate()（Layout.vue），
 * 全仓库只有 router.ts 自己的守卫读过 meta.superOnly，没有任何地方读 meta.title、
 * 也没有任何地方给 document.title 赋值。而这 23 条死文案保存着一整套与实际显示
 * 系统性冲突的旧词汇（房产管理/工作照片墙/收费规则/租户管理/绑定审核/收缴看板…），
 * 任何人照着它改文案都会改错地方——这是下一轮术语漂移的温床。
 */
import { createRouter, createWebHashHistory } from 'vue-router';
import { store } from './store';
import Layout from './layout/Layout.vue';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: () => import('./views/Login.vue') },
    {
      path: '/',
      component: Layout,
      children: [
        { path: '', redirect: '/dashboard' },
        { path: 'dashboard', component: () => import('./views/Dashboard.vue') },
        { path: 'communities', component: () => import('./views/Communities.vue') },
        { path: 'houses', component: () => import('./views/Houses.vue') },
        {
          path: 'houses/:houseId',
          component: () => import('./views/HouseProfile.vue'),
        },
        { path: 'bindings', component: () => import('./views/Bindings.vue') },
        { path: 'tickets', component: () => import('./views/Tickets.vue') },
        { path: 'announcements', component: () => import('./views/Announcements.vue') },
        { path: 'visitor-passes', component: () => import('./views/VisitorPasses.vue') },
        { path: 'work-logs', component: () => import('./views/WorkLogs.vue') },
        { path: 'services', component: () => import('./views/Services.vue') },
        { path: 'coupons', component: () => import('./views/Coupons.vue') },
        { path: 'fee-rules', component: () => import('./views/FeeRules.vue') },
        { path: 'meters', component: () => import('./views/MeterReadings.vue') },
        { path: 'share-pools', component: () => import('./views/SharePools.vue') },
        { path: 'bill-run', component: () => import('./views/BillRun.vue') },
        { path: 'arrears', component: () => import('./views/Arrears.vue') },
        { path: 'bills', component: () => import('./views/BillList.vue') },
        { path: 'bill-import', component: () => import('./views/BillImport.vue') },
        { path: 'payments', component: () => import('./views/Payments.vue') },
        { path: 'reconciliations', component: () => import('./views/Reconciliations.vue') },
        { path: 'invoices', component: () => import('./views/InvoiceApplications.vue') },
        { path: 'billing-settings', component: () => import('./views/BillingSettings.vue') },
        { path: 'operations', component: () => import('./views/Operations.vue') },
        { path: 'audit-logs', component: () => import('./views/AuditLogs.vue') },
        { path: 'notify-logs', component: () => import('./views/NotifyLogs.vue') },
        { path: 'tenants', component: () => import('./views/Tenants.vue'), meta: { superOnly: true } },
      ],
    },
  ],
});

router.beforeEach((to) => {
  if (to.path !== '/login' && !store.token) return '/login';
  if (to.meta.superOnly && store.profile?.role !== 'SUPER_ADMIN') return '/dashboard';
  return true;
});
