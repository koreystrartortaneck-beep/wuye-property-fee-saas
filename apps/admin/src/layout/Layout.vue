<template>
  <div class="shell">
    <!-- 移动端遮罩 -->
    <div v-if="drawerOpen" class="scrim" @click="drawerOpen = false" />

    <aside class="sidebar" :class="{ 'is-mini': mini && !drawerOpen, 'is-drawer': drawerOpen }">
      <div class="brand">
        <span class="brand-mark">港</span>
        <span v-show="!mini || drawerOpen" class="brand-text">
          <span class="brand-name">{{ tenantName }}</span>
          <span class="brand-sub">物业管理</span>
        </span>
      </div>

      <nav class="nav">
        <button
          v-for="group in visibleNav"
          :key="group.key"
          class="nav-item"
          :class="{ on: currentGroupKey === group.key }"
          :title="mini ? group.label : undefined"
          @click="openGroup(group)"
        >
          <el-icon class="nav-icon"><component :is="icons[group.icon]" /></el-icon>
          <span v-show="!mini || drawerOpen" class="nav-label">{{ group.label }}</span>
          <span v-if="groupBadge(group) > 0" class="nav-badge">{{ groupBadge(group) }}</span>
        </button>
      </nav>

      <div class="side-foot">
        <button class="nav-item ghost" :title="mini ? '展开' : undefined" @click="mini = !mini">
          <el-icon class="nav-icon"><component :is="mini ? icons.Expand : icons.Fold" /></el-icon>
          <span v-show="!mini || drawerOpen" class="nav-label">收起侧栏</span>
        </button>
      </div>
    </aside>

    <div class="main-col">
      <header class="topbar">
        <button class="icon-btn only-mobile" aria-label="菜单" @click="drawerOpen = true">
          <el-icon><component :is="icons.Fold" /></el-icon>
        </button>

        <button class="search-trigger" @click="palette?.open()">
          <el-icon><component :is="icons.Search" /></el-icon>
          <span class="search-text">搜索房号、业主、手机号…</span>
          <span class="search-kbd">⌘K</span>
        </button>

        <div class="topbar-right">
          <el-select
            v-if="isSuper"
            v-model="actingTenant"
            placeholder="选择物业公司"
            size="small"
            class="tenant-pick"
            @change="onTenantChange"
          >
            <el-option v-for="t in tenants" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
          <span class="who">{{ store.profile?.name }}<i class="who-role">{{ roleLabel }}</i></span>
          <el-button size="small" text @click="logout">退出</el-button>
        </div>
      </header>

      <div class="page-head">
        <div class="page-head-top">
          <h1 class="page-title">{{ pageTitle }}</h1>
          <p v-if="pageHint" class="page-hint">{{ pageHint }}</p>
        </div>
        <div v-if="siblings.length > 1" class="segmented">
          <button
            v-for="p in siblings"
            :key="p.path"
            class="seg"
            :class="{ on: route.path === p.path }"
            @click="router.push(p.path)"
          >
            {{ p.label }}
            <span v-if="p.badge && badges[p.badge] > 0" class="seg-badge">{{ badges[p.badge] }}</span>
          </button>
        </div>
      </div>

      <main class="page-body">
        <router-view :key="store.actingTenantId" />
      </main>
    </div>

    <CommandPalette ref="palette" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ChatDotSquare,
  Expand,
  Fold,
  HomeFilled,
  Odometer,
  Search,
  Setting,
  Tickets,
  Wallet,
} from '@element-plus/icons-vue';
import { api, type Page } from '../api';
import { store } from '../store';
import { NAV, locate, type NavGroup } from '../nav';
import { badges, refreshBadges, startBadgePolling, stopBadgePolling } from '../badges';
import CommandPalette from '../components/CommandPalette.vue';

const icons: Record<string, unknown> = {
  Odometer,
  HomeFilled,
  Tickets,
  Wallet,
  ChatDotSquare,
  Setting,
  Search,
  Fold,
  Expand,
};

const route = useRoute();
const router = useRouter();
const palette = ref<{ open: () => void } | null>(null);

const isSuper = computed(() => store.profile?.role === 'SUPER_ADMIN');
const roleLabel = computed(
  () => ({ SUPER_ADMIN: '平台超管', TENANT_ADMIN: '管理员', STAFF: '员工' })[store.profile?.role ?? 'STAFF'],
);
const tenants = ref<{ id: string; name: string }[]>([]);
const actingTenant = ref(store.actingTenantId);
const tenantName = computed(
  () => tenants.value.find((t) => t.id === store.actingTenantId)?.name ?? '物业后台',
);

/** 平台级页面仅超管可见 */
const visibleNav = computed(() =>
  NAV.map((g) => ({ ...g, pages: g.pages.filter((p) => !p.superOnly || isSuper.value) })).filter(
    (g) => g.pages.length > 0,
  ),
);

const located = computed(() => locate(route.path));
const currentGroupKey = computed(() => located.value?.group.key ?? '');
const siblings = computed(() => visibleNav.value.find((x) => x.key === currentGroupKey.value)?.pages ?? []);
const pageTitle = computed(() => located.value?.page.title ?? located.value?.page.label ?? '');
const pageHint = computed(() => located.value?.page.hint ?? '');

function groupBadge(group: NavGroup): number {
  return group.pages.reduce((sum, p) => sum + (p.badge ? badges[p.badge] : 0), 0);
}

/** 点分组 → 进该组第一个页面；已在组内则不跳，避免打断当前操作 */
function openGroup(group: NavGroup) {
  drawerOpen.value = false;
  if (currentGroupKey.value === group.key) return;
  const first = group.pages[0];
  if (first) void router.push(first.path);
}

/* ---------- 响应式：宽屏全展开 / 中屏图标 / 窄屏抽屉 ---------- */
const mini = ref(false);
const drawerOpen = ref(false);

function applyViewport() {
  const w = window.innerWidth;
  mini.value = w < 1200;
  if (w >= 900) drawerOpen.value = false;
}

watch(
  () => route.path,
  () => (drawerOpen.value = false),
);

onMounted(async () => {
  applyViewport();
  window.addEventListener('resize', applyViewport);
  startBadgePolling();
  if (isSuper.value) {
    try {
      const page = await api<Page<{ id: string; name: string }>>('/admin/tenants?pageSize=200', {
        silent: true,
      });
      tenants.value = page.list;
      if (!actingTenant.value && page.list.length > 0) {
        actingTenant.value = page.list[0].id;
        store.setActingTenant(actingTenant.value);
      }
      // 超管首屏：startBadgePolling 先于租户列表返回，此时无租户上下文导致
      // 计数恒为 0，须在租户就绪后补算一次。
      void refreshBadges();
    } catch {
      tenants.value = [];
    }
  }
});

onUnmounted(() => {
  window.removeEventListener('resize', applyViewport);
  stopBadgePolling();
});

function onTenantChange(id: string) {
  store.setActingTenant(id);
  // 角标按租户统计：切换后若不立刻重算，侧栏最多 60 秒仍显示上一个租户的
  // 待办数，点进去却是空列表。
  void refreshBadges();
}

function logout() {
  stopBadgePolling();
  store.logout();
  void router.push('/login');
}
</script>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
  background: var(--bg-page);
}

/* ---------- 侧栏 ---------- */
.sidebar {
  width: var(--sidebar-w);
  flex: 0 0 var(--sidebar-w);
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  transition: width var(--dur) var(--ease), flex-basis var(--dur) var(--ease);
}
.sidebar.is-mini {
  width: var(--sidebar-w-collapsed);
  flex-basis: var(--sidebar-w-collapsed);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--header-h);
  padding: 0 var(--sp-4);
  border-bottom: 1px solid var(--border);
}
.brand-mark {
  flex: 0 0 26px;
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  background: var(--brand-ink);
  color: var(--brand-gold);
  font-size: var(--fs-13);
  font-weight: var(--fw-bold);
  display: flex;
  align-items: center;
  justify-content: center;
}
.brand-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.brand-name {
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.brand-sub {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

.nav {
  flex: 1;
  padding: var(--sp-3) var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  padding: var(--sp-2) var(--sp-3);
  border: none;
  background: transparent;
  border-radius: var(--r-sm);
  cursor: pointer;
  color: var(--text-secondary);
  font-size: var(--fs-13);
  font-weight: var(--fw-medium);
  text-align: left;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.nav-item.on {
  background: var(--bg-card);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm);
}
/* 选中态用品牌金做左侧细标记：品牌只做点缀，不做大面积色块 */
.nav-item.on::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 16px;
  border-radius: var(--r-full);
  background: var(--brand-gold);
}
.nav-icon {
  flex: 0 0 18px;
  font-size: 17px;
}
.nav-label {
  flex: 1;
  white-space: nowrap;
}
.nav-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--r-full);
  background: var(--danger);
  color: var(--text-inverse);
  font-size: var(--fs-11);
  font-weight: var(--fw-semibold);
  display: flex;
  align-items: center;
  justify-content: center;
  font-variant-numeric: tabular-nums;
}
.sidebar.is-mini .nav-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  min-width: 8px;
  height: 8px;
  padding: 0;
  font-size: 0;
}
.side-foot {
  padding: var(--sp-2);
  border-top: 1px solid var(--border);
}
.nav-item.ghost {
  color: var(--text-tertiary);
  font-weight: var(--fw-regular);
}

/* ---------- 顶栏 ---------- */
.main-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.topbar {
  height: var(--header-h);
  flex: 0 0 var(--header-h);
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 0 var(--sp-6);
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
}
.icon-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 17px;
  padding: var(--sp-1);
  border-radius: var(--r-sm);
}
.icon-btn:hover {
  background: var(--bg-hover);
}
.only-mobile {
  display: none;
}

.search-trigger {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  max-width: 380px;
  height: 32px;
  padding: 0 var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--c-gray-100);
  color: var(--text-tertiary);
  font-size: var(--fs-13);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.search-trigger:hover {
  border-color: var(--border-strong);
  background: var(--bg-card);
}
.search-text {
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.search-kbd {
  font-size: var(--fs-11);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
  background: var(--bg-card);
}

.topbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.tenant-pick {
  width: 170px;
}
.who {
  font-size: var(--fs-12);
  color: var(--text-primary);
  display: flex;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
}
.who-role {
  font-style: normal;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

/* ---------- 页头 ---------- */
.page-head {
  padding: var(--sp-6) var(--sp-6) 0;
}
.page-head-top {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.page-title {
  margin: 0;
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.01em;
  color: var(--text-primary);
}
.page-hint {
  margin: 0;
  font-size: var(--fs-12);
  color: var(--text-secondary);
}
.segmented {
  display: inline-flex;
  gap: 2px;
  margin-top: var(--sp-4);
  padding: 3px;
  background: var(--c-gray-200);
  border-radius: var(--r-sm);
  flex-wrap: wrap;
}
.seg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  padding: 5px var(--sp-3);
  border-radius: 5px;
  cursor: pointer;
  font-size: var(--fs-12);
  font-weight: var(--fw-medium);
  color: var(--text-secondary);
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.seg:hover {
  color: var(--text-primary);
}
.seg.on {
  background: var(--bg-card);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm);
}
.seg-badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: var(--r-full);
  background: var(--danger);
  color: var(--text-inverse);
  font-size: var(--fs-11);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-variant-numeric: tabular-nums;
}

.page-body {
  flex: 1;
  min-width: 0;
  padding: var(--sp-4) var(--sp-6) var(--sp-8);
  overflow-x: auto;
}

/* ---------- 遮罩 ---------- */
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.28);
  z-index: 1500;
}

/* ---------- 窄屏 ---------- */
@media (max-width: 900px) {
  .only-mobile {
    display: inline-flex;
  }
  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 1600;
    transform: translateX(-100%);
    width: var(--sidebar-w);
    flex-basis: var(--sidebar-w);
    box-shadow: var(--shadow-lg);
  }
  .sidebar.is-drawer {
    transform: translateX(0);
  }
  .topbar {
    padding: 0 var(--sp-4);
  }
  .page-head {
    padding: var(--sp-4) var(--sp-4) 0;
  }
  .page-body {
    padding: var(--sp-3) var(--sp-4) var(--sp-8);
  }
  .who {
    display: none;
  }
  .tenant-pick {
    width: 130px;
  }
  .search-kbd {
    display: none;
  }
}
</style>
