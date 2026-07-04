<template>
  <el-container class="layout">
    <el-aside width="210px" class="aside">
      <div class="brand">物业费管理后台</div>
      <el-menu :default-active="$route.path" router background-color="#102033" text-color="#c8c2b8" active-text-color="#e8c98a">
        <el-menu-item index="/dashboard">收缴看板</el-menu-item>
        <el-menu-item index="/communities">小区管理</el-menu-item>
        <el-menu-item index="/houses">房产管理</el-menu-item>
        <el-menu-item index="/bindings">绑定审核</el-menu-item>
        <el-menu-item index="/tickets">报事报修</el-menu-item>
        <el-menu-item index="/announcements">社区公告</el-menu-item>
        <el-menu-item index="/visitor-passes">访客通行</el-menu-item>
        <el-menu-item index="/fee-rules">收费规则</el-menu-item>
        <el-menu-item index="/meters">抄表录入</el-menu-item>
        <el-menu-item index="/share-pools">公摊录入</el-menu-item>
        <el-menu-item index="/bills">出账与账单</el-menu-item>
        <el-menu-item index="/notify-logs">通知记录</el-menu-item>
        <el-menu-item v-if="isSuper" index="/tenants">租户管理</el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <div class="header-title">{{ $route.meta.title }}</div>
        <div class="header-right">
          <el-select
            v-if="isSuper"
            v-model="actingTenant"
            placeholder="选择操作租户"
            size="small"
            style="width: 200px"
            @change="onTenantChange"
          >
            <el-option v-for="t in tenants" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
          <span class="who">{{ store.profile?.name }}（{{ roleLabel }}）</span>
          <el-button size="small" @click="logout">退出</el-button>
        </div>
      </el-header>
      <el-main class="main">
        <router-view :key="store.actingTenantId" />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, type Page } from '../api';
import { store } from '../store';

const router = useRouter();
const isSuper = computed(() => store.profile?.role === 'SUPER_ADMIN');
const roleLabel = computed(
  () => ({ SUPER_ADMIN: '平台超管', TENANT_ADMIN: '物业管理员', STAFF: '员工' })[store.profile?.role ?? 'STAFF'],
);
const tenants = ref<{ id: string; name: string }[]>([]);
const actingTenant = ref(store.actingTenantId);

onMounted(async () => {
  if (isSuper.value) {
    const page = await api<Page<{ id: string; name: string }>>('/admin/tenants?pageSize=200');
    tenants.value = page.list;
    if (!actingTenant.value && page.list.length > 0) {
      actingTenant.value = page.list[0].id;
      store.setActingTenant(actingTenant.value);
    }
  }
});

function onTenantChange(id: string) {
  store.setActingTenant(id);
}

function logout() {
  store.logout();
  router.push('/login');
}
</script>

<style scoped>
.layout {
  min-height: 100vh;
}
.aside {
  background: #102033;
}
.brand {
  color: #e8c98a;
  font-weight: 800;
  padding: 20px 16px;
  font-size: 16px;
}
.aside :deep(.el-menu) {
  border-right: none;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fffaf2;
  border-bottom: 1px solid #eee3d2;
}
.header-title {
  font-weight: 700;
  color: #102033;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.who {
  color: #8a7f73;
  font-size: 13px;
}
.main {
  background: #f6f0e7;
}
</style>
