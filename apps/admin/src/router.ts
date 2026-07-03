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
        { path: 'dashboard', component: () => import('./views/Dashboard.vue'), meta: { title: '收缴看板' } },
        { path: 'communities', component: () => import('./views/Communities.vue'), meta: { title: '小区管理' } },
        { path: 'houses', component: () => import('./views/Houses.vue'), meta: { title: '房产管理' } },
        { path: 'bindings', component: () => import('./views/Bindings.vue'), meta: { title: '绑定审核' } },
        { path: 'fee-rules', component: () => import('./views/FeeRules.vue'), meta: { title: '收费规则' } },
        { path: 'meters', component: () => import('./views/MeterReadings.vue'), meta: { title: '抄表录入' } },
        { path: 'share-pools', component: () => import('./views/SharePools.vue'), meta: { title: '公摊录入' } },
        { path: 'bills', component: () => import('./views/Bills.vue'), meta: { title: '出账与账单' } },
        { path: 'notify-logs', component: () => import('./views/NotifyLogs.vue'), meta: { title: '通知记录' } },
        { path: 'tenants', component: () => import('./views/Tenants.vue'), meta: { title: '租户管理', superOnly: true } },
      ],
    },
  ],
});

router.beforeEach((to) => {
  if (to.path !== '/login' && !store.token) return '/login';
  if (to.meta.superOnly && store.profile?.role !== 'SUPER_ADMIN') return '/dashboard';
  return true;
});
