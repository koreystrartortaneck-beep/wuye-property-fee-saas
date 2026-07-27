<template>
  <el-dialog
    v-model="visible"
    :show-close="false"
    :close-on-click-modal="true"
    width="560px"
    top="12vh"
    class="palette-dialog"
    @opened="focusInput"
  >
    <div class="palette">
      <div class="palette-input">
        <el-icon class="palette-icon"><Search /></el-icon>
        <input
          ref="inputEl"
          v-model="keyword"
          class="palette-field"
          placeholder="搜索房号、业主姓名、手机号，或跳转页面"
          @keydown.down.prevent="move(1)"
          @keydown.up.prevent="move(-1)"
          @keydown.enter.prevent="choose()"
          @keydown.esc="visible = false"
        />
        <span class="palette-esc">esc</span>
      </div>

      <div class="palette-body">
        <template v-if="pageHits.length">
          <div class="palette-section">页面</div>
          <button
            v-for="(item, i) in pageHits"
            :key="item.path"
            class="palette-row"
            :class="{ on: cursor === i }"
            @mouseenter="cursor = i"
            @click="go(item.path)"
          >
            <span class="palette-row-main">{{ item.groupLabel }} · {{ item.label }}</span>
            <span class="palette-row-sub">{{ item.hint }}</span>
          </button>
        </template>

        <template v-if="houseHits.length">
          <div class="palette-section">房屋 · 回车打开住户档案</div>
          <button
            v-for="(h, i) in houseHits"
            :key="h.id"
            class="palette-row"
            :class="{ on: cursor === pageHits.length + i }"
            @mouseenter="cursor = pageHits.length + i"
            @click="goHouse(h)"
          >
            <span class="palette-row-main">{{ h.displayName }}（{{ h.code }}）</span>
            <span class="palette-row-sub">
              {{ h.ownerName || '未登记业主' }}
              <template v-if="h.ownerPhone"> · {{ h.ownerPhone }}</template>
              <template v-if="h.area"> · {{ h.area }} ㎡</template>
            </span>
          </button>
        </template>

        <div v-if="keyword && !loading && !pageHits.length && !houseHits.length" class="palette-empty">
          没有找到「{{ keyword }}」
        </div>
        <div v-if="!keyword" class="palette-tip">
          输入房号或业主姓名可直接定位住户；输入功能名可跳转页面
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Search } from '@element-plus/icons-vue';
import { api, qs, type Page } from '../api';
import { NAV } from '../nav';
import { store } from '../store';

interface House {
  id: string;
  code: string;
  displayName: string;
  ownerName?: string | null;
  ownerPhone?: string | null;
  area?: string | number | null;
}

const router = useRouter();
const visible = ref(false);
const keyword = ref('');
const cursor = ref(0);
const loading = ref(false);
const houses = ref<House[]>([]);
const inputEl = ref<HTMLInputElement | null>(null);

const isSuper = computed(() => store.profile?.role === 'SUPER_ADMIN');

/** 页面候选：按分组标签 + 页面标签 + 说明做包含匹配 */
const pageHits = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  const all = NAV.flatMap((g) =>
    g.pages
      .filter((p) => !p.superOnly || isSuper.value)
      .map((p) => ({ path: p.path, label: p.label, hint: p.hint ?? '', groupLabel: g.label })),
  );
  if (!k) return all.slice(0, 6);
  return all.filter((p) => `${p.groupLabel}${p.label}${p.hint}`.toLowerCase().includes(k)).slice(0, 6);
});

const houseHits = computed(() => houses.value.slice(0, 6));
const totalHits = computed(() => pageHits.value.length + houseHits.value.length);

let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(keyword, (k) => {
  cursor.value = 0;
  if (searchTimer) clearTimeout(searchTimer);
  const term = k.trim();
  if (term.length < 1) {
    houses.value = [];
    return;
  }
  searchTimer = setTimeout(async () => {
    loading.value = true;
    try {
      const res = await api<Page<House>>(`/admin/houses${qs({ keyword: term, page: 1, pageSize: 6 })}`, {
        silent: true,
      });
      houses.value = res.list ?? [];
    } catch {
      houses.value = [];
    } finally {
      loading.value = false;
    }
  }, 220);
});

function move(step: number) {
  if (totalHits.value === 0) return;
  cursor.value = (cursor.value + step + totalHits.value) % totalHits.value;
}

function choose() {
  if (cursor.value < pageHits.value.length) {
    const hit = pageHits.value[cursor.value];
    if (hit) go(hit.path);
    return;
  }
  const house = houseHits.value[cursor.value - pageHits.value.length];
  if (house) goHouse(house);
}

function go(path: string) {
  visible.value = false;
  void router.push(path);
}

function goHouse(h: House) {
  visible.value = false;
  // 直达住户档案：该户的账单/缴费/绑定/报修/开票一次看全，
  // 这是「业主来电问费用」场景的落点。
  void router.push(`/houses/${h.id}`);
}

function open() {
  keyword.value = '';
  houses.value = [];
  cursor.value = 0;
  visible.value = true;
}

function focusInput() {
  void nextTick(() => inputEl.value?.focus());
}

function onHotkey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    open();
  }
}

window.addEventListener('keydown', onHotkey);
// 组件卸载时必须移除，否则热键监听会随实例累积泄漏
onUnmounted(() => window.removeEventListener('keydown', onHotkey));

defineExpose({ open });
</script>

<style scoped>
/*
 * 命令面板要占满弹窗：Element 默认给 body 留 16px 内边距、给 header 留高度，
 * 搜索框的分隔线因此内缩、顶部还有一条空白。这里清零后才是「面板」的样子。
 * 原先 .palette-dialog / .palette 只是没有任何规则的空钩子。
 */
.palette-dialog :deep(.el-dialog__header) {
  display: none;
}
.palette-dialog :deep(.el-dialog__body) {
  padding: 0;
}
.palette-dialog :deep(.el-dialog) {
  border-radius: var(--r-lg);
  overflow: hidden;
}
.palette {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.palette-input {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4);
  height: 52px;
  border-bottom: 1px solid var(--border);
}
.palette-icon {
  color: var(--text-tertiary);
  font-size: 16px;
}
.palette-field {
  flex: 1;
  border: none;
  outline: none;
  font-size: var(--fs-15);
  color: var(--text-primary);
  background: transparent;
}
.palette-field::placeholder {
  color: var(--text-tertiary);
}
.palette-esc {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 2px 6px;
}
.palette-body {
  max-height: 44vh;
  overflow-y: auto;
  padding: var(--sp-2) 0 var(--sp-2);
}
.palette-section {
  padding: var(--sp-2) var(--sp-4) var(--sp-1);
  font-size: var(--fs-11);
  font-weight: var(--fw-semibold);
  color: var(--text-tertiary);
  letter-spacing: 0.04em;
}
.palette-row {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--sp-2) var(--sp-4);
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background var(--dur-fast) var(--ease);
}
.palette-row.on {
  background: var(--bg-active);
}
.palette-row-main {
  font-size: var(--fs-13);
  font-weight: var(--fw-medium);
  color: var(--text-primary);
}
.palette-row-sub {
  font-size: var(--fs-12);
  color: var(--text-secondary);
}
.palette-empty,
.palette-tip {
  padding: var(--sp-6) var(--sp-4);
  text-align: center;
  font-size: var(--fs-12);
  color: var(--text-tertiary);
}
</style>
