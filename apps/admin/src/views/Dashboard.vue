<template>
  <div v-loading="loading">
    <!-- 阶段向导：物业工作是强周期的，首屏直接说明现在该干什么 -->
    <div v-if="today" class="phase" :class="phaseClass">
      <div class="phase-text">
        <h2 class="phase-title">{{ phaseTitle }}</h2>
        <p class="phase-desc">{{ phaseDesc }}</p>
      </div>
      <el-button v-if="phaseAction" type="primary" size="large" @click="router.push(phaseAction.to)">
        {{ phaseAction.label }}
      </el-button>
    </div>

    <!--
      查户：业主来电问「我这个月交了没」是日常最高频动作，之前只能先进「业主」页
      再搜，用户反馈找不到档案入口。这里直接给一个首屏搜索框，唯一命中直接进档案。
    -->
    <el-card class="block lookup">
      <div class="lk-row">
        <div class="lk-text">
          <b class="lk-title">查业主档案</b>
          <span class="lk-desc">输入房号、业主姓名或手机号，直接看这户的账单、缴费、绑定、报修、开票</span>
        </div>
        <el-input
          v-model="lookupKeyword"
          class="lk-input"
          placeholder="如 1-101 / 张三 / 13800138000"
          clearable
          :disabled="lookingUp"
          @keyup.enter="doLookup"
        />
        <el-button type="primary" :loading="lookingUp" :disabled="!lookupKeyword.trim()" @click="doLookup">
          查询
        </el-button>
      </div>
    </el-card>

    <!-- 待我处理：别人在等我做的事 -->
    <el-card v-if="today" class="block">
      <template #header>
        待我处理
        <span v-if="today.todoTotal > 0" class="hd-count">{{ today.todoTotal }}</span>
      </template>
      <div v-if="today.todos.length" class="card-grid">
        <button v-for="t in today.todos" :key="t.key" class="todo" @click="router.push(t.to)">
          <span class="todo-count">{{ t.count }}</span>
          <span class="todo-label">{{ t.label }}</span>
          <span class="todo-go">›</span>
        </button>
      </div>
      <div v-else class="clear-note">没有待处理事项，一切都跟上了。</div>
    </el-card>

    <!-- 本月收缴 + 欠费 -->
    <div v-if="today" class="card-grid-wide">
      <el-card class="block">
        <template #header>{{ periodLabel }}收缴进度</template>
        <div class="stat-row">
          <div class="stat">
            <span class="stat-label">应收</span>
            <b class="stat-value">¥{{ yuan(today.collection.billAmount) }}</b>
          </div>
          <div class="stat">
            <span class="stat-label">实收</span>
            <b class="stat-value is-good">¥{{ yuan(today.collection.paidAmount) }}</b>
          </div>
          <div class="stat">
            <span class="stat-label">笔数</span>
            <b class="stat-value">{{ today.collection.paidCount }} / {{ today.collection.billCount }}</b>
          </div>
        </div>
        <div class="rate-row">
          <span class="rate-label">收缴率</span>
          <el-progress
            :percentage="clampRate(today.collection.rate)"
            :stroke-width="14"
            :color="rateColor(today.collection.rate)"
            class="rate-bar"
          />
        </div>
      </el-card>

      <el-card class="block">
        <template #header>欠费情况（全部账期）</template>
        <div class="stat-row">
          <div class="stat">
            <span class="stat-label">欠费合计</span>
            <b class="stat-value" :class="{ 'is-bad': Number(today.arrears.amount) > 0 }">
              ¥{{ yuan(today.arrears.amount) }}
            </b>
            <span class="stat-sub">{{ today.arrears.houses }} 户</span>
          </div>
          <div class="stat">
            <span class="stat-label">其中已逾期</span>
            <b class="stat-value" :class="{ 'is-bad': Number(today.arrears.overdueAmount) > 0 }">
              ¥{{ yuan(today.arrears.overdueAmount) }}
            </b>
            <span class="stat-sub">{{ today.arrears.overdueHouses }} 户</span>
          </div>
        </div>
        <el-button
          v-if="today.arrears.houses > 0"
          type="primary"
          text
          @click="router.push('/arrears')"
        >去催缴 →</el-button>
      </el-card>
    </div>

    <!-- 各小区对比：仅多小区时有意义（单小区只有一行，纯噪音） -->
    <el-card v-if="rowsData.length > 1" class="block">
      <template #header>
        各小区收缴情况
        <el-date-picker
          v-model="period"
          type="month"
          value-format="YYYY-MM"
          format="YYYY 年 M 月"
          placeholder="全部账期"
          clearable
          size="small"
          class="hd-period"
          @change="loadByCommunity"
        />
      </template>
      <el-table :data="rowsData" size="small">
        <el-table-column prop="name" label="小区" min-width="150" />
        <el-table-column label="应收（元）" width="130" align="right">
          <template #default="{ row }"><span class="num">{{ yuan(row.billAmount) }}</span></template>
        </el-table-column>
        <el-table-column label="实收（元）" width="130" align="right">
          <template #default="{ row }"><span class="num">{{ yuan(row.paidAmount) }}</span></template>
        </el-table-column>
        <el-table-column label="笔数" width="100" align="right">
          <template #default="{ row }">
            <span class="num">{{ row.paidCount }} / {{ row.billCount }}</span>
          </template>
        </el-table-column>
        <el-table-column label="收缴率" min-width="200">
          <template #default="{ row }">
            <el-progress :percentage="clampRate(row.rate)" :stroke-width="14" :color="rateColor(row.rate)" />
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';
import { yuan } from '../finance';

interface Todo {
  key: string;
  label: string;
  count: number;
  to: string;
}
interface Today {
  period: string;
  phase: 'NEED_BILLING' | 'NEED_PUBLISH' | 'DUNNING' | 'RECONCILE' | 'CLEAR';
  todos: Todo[];
  todoTotal: number;
  collection: { billAmount: string; paidAmount: string; billCount: number; paidCount: number; rate: number };
  arrears: { amount: string; houses: number; overdueAmount: string; overdueHouses: number };
}
interface CommunityRow {
  communityId: string;
  name: string;
  billAmount: string;
  paidAmount: string;
  billCount: number;
  paidCount: number;
  rate: number;
}

const router = useRouter();
const today = ref<Today | null>(null);
const rowsData = ref<CommunityRow[]>([]);
const period = ref('');
const loading = ref(false);

/** 查户：唯一命中直接进档案，多条则落到业主列表（已带关键词），零条给明确提示 */
const lookupKeyword = ref('');
const lookingUp = ref(false);

async function doLookup() {
  const keyword = lookupKeyword.value.trim();
  if (!keyword || lookingUp.value) return;
  lookingUp.value = true;
  try {
    const data = await api<Page<{ id: string }>>(`/admin/houses${qs({ keyword, page: 1, pageSize: 2 })}`);
    if (data.total === 0) {
      ElMessage.warning('没有匹配的房屋，检查一下房号或手机号');
    } else if (data.total === 1) {
      router.push(`/houses/${data.list[0].id}`);
    } else {
      router.push({ path: '/houses', query: { keyword } });
    }
  } finally {
    lookingUp.value = false;
  }
}

const periodLabel = computed(() => {
  if (!today.value) return '本月';
  const [y, m] = today.value.period.split('-');
  return `${y} 年 ${Number(m)} 月`;
});

/** 阶段文案：把「系统等你操作」说成人话，并给出唯一的下一步动作 */
const PHASE: Record<Today['phase'], { title: string; desc: string; action?: Todo }> = {
  NEED_BILLING: {
    title: '该出本月账单了',
    desc: '本月还没有生成任何账单，业主也就看不到费用。按 4 步走完即可发布。',
    action: { key: 'go', label: '开始出账', count: 0, to: '/bill-run' },
  },
  NEED_PUBLISH: {
    title: '账单已生成，还没发布',
    desc: '业主目前看不到这些账单，核对金额后发布才能开始收费。',
    action: { key: 'go', label: '去核对并发布', count: 0, to: '/bill-run' },
  },
  DUNNING: {
    title: '本月进入催缴阶段',
    desc: '账单已发布，接下来盯欠费：可按逾期天数筛选并批量推送催缴提醒。',
    action: { key: 'go', label: '查看欠费清单', count: 0, to: '/arrears' },
  },
  RECONCILE: {
    title: '有对账差异待处置',
    desc: '本地流水与微信支付的对账结果存在差异，需要人工核对后处置。',
    action: { key: 'go', label: '去处理差异', count: 0, to: '/reconciliations' },
  },
  CLEAR: {
    title: '本月工作都跟上了',
    desc: '账单已发布、没有欠费、也没有对账差异。可以看看报事报修与公告。',
  },
};

const phaseTitle = computed(() => (today.value ? PHASE[today.value.phase].title : ''));
const phaseDesc = computed(() => (today.value ? PHASE[today.value.phase].desc : ''));
const phaseAction = computed(() => (today.value ? PHASE[today.value.phase].action : undefined));
const phaseClass = computed(() => {
  const p = today.value?.phase;
  if (p === 'CLEAR') return 'is-clear';
  if (p === 'RECONCILE') return 'is-alert';
  return 'is-todo';
});

/** 收缴率可能因退款/多缴越界，越界会让 el-progress 直接报错 */
/**
 * 收缴率钳到 0–100，保留一位小数。
 *
 * 后端两处的单位约定不同，这是刻意的、不要「统一」：
 *   stats / today 的 rate 是**百分数**（如 98.5，后端已 Math.round(x*1000)/10）
 *   operations metrics 的 rate 是**比值**（0–1），所以 Operations 的 pct() 要乘 100
 * 真正的不一致在小数位：这里原先 Math.round 抹成整数，于是同一个收缴率在「今天」
 * 显示 99%、在运维页显示 98.6%，看起来像两个数。改为同样保留一位小数。
 *
 * el-progress 的 percentage 接受小数，但要求 0–100 且不为 NaN。
 */
function clampRate(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}
function rateColor(v: unknown): string {
  const n = clampRate(v);
  if (n >= 80) return '#34c759';
  if (n >= 50) return '#ff9500';
  return '#ff3b30';
}

async function loadToday() {
  today.value = await api<Today>('/admin/today');
}

async function loadByCommunity() {
  rowsData.value = await api<CommunityRow[]>(`/admin/stats/by-community${qs({ period: period.value })}`);
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    await Promise.all([loadToday(), loadByCommunity()]);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
/*
 * 统计数字改用 ui.css 的 .stat / .stat-value（28px），
 * 原来本页自带的 .fig-value 只有 20px，和「首屏最该被看到的数字」不相称，
 * 也与其它页面各写一套的问题同源。
 */

/* ---------- 查户搜索条 ---------- */
.lookup {
  margin-bottom: var(--sp-2);
}
.lk-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.lk-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.lk-title {
  font-size: var(--fs-15);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}
.lk-desc {
  margin-top: 2px;
  font-size: var(--fs-12);
  color: var(--text-tertiary);
}
.lk-input {
  width: 260px;
}
@media (max-width: 700px) {
  /* 窄屏下搜索框占满一行，避免被挤成不可用的窄条 */
  .lk-input {
    width: 100%;
  }
}

.phase {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-6);
  padding: var(--sp-6);
  /* 圆角与阴影跟卡片保持一致，否则首屏这块横幅和下面的卡片明显不是一套东西 */
  border-radius: var(--r-lg);
  background: var(--bg-card);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
  flex-wrap: wrap;
  margin-bottom: var(--sp-4);
}

/* 文案区吃掉剩余宽度，按钮才会稳定贴右；min-width:0 让长文案能正常折行 */
.phase-text {
  flex: 1;
  min-width: 0;
}
.phase.is-todo {
  border-left: 3px solid var(--primary);
}
.phase.is-alert {
  border-left: 3px solid var(--danger);
}
.phase.is-clear {
  border-left: 3px solid var(--success);
}
.phase-title {
  margin: 0;
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}
.phase-desc {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-13);
  color: var(--text-secondary);
  line-height: var(--lh-normal);
}

.block {
  margin-top: var(--sp-4);
}
.hd-count {
  margin-left: var(--sp-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--r-full);
  background: var(--danger);
  color: var(--text-inverse);
  font-size: var(--fs-11);
  font-variant-numeric: tabular-nums;
}
/*
 * .el-card__header 是 flex 容器（见 styles/ui.css），flex 子项上的 float 会被浏览器
 * 完全忽略——这条 float: right 一直是空操作，元素其实是靠 flex 的默认排列落在那里的。
 * 想靠右应该用 margin-left: auto。
 */
.hd-period {
  margin-left: auto;
  width: 150px;
}

.todo {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--c-gray-50);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.todo:hover {
  border-color: var(--primary);
  background: var(--bg-card);
}
.todo-count {
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
  color: var(--danger-text);
  font-variant-numeric: tabular-nums;
  min-width: 28px;
}
.todo-label {
  flex: 1;
  font-size: var(--fs-13);
  color: var(--text-primary);
}
.todo-go {
  color: var(--text-tertiary);
  font-size: var(--fs-17);
}
.clear-note {
  padding: var(--sp-4) 0;
  text-align: center;
  font-size: var(--fs-13);
  color: var(--text-secondary);
}

.grid .block {
  margin-top: 0;
}
.rate-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-4);
}
.rate-label {
  font-size: var(--fs-12);
  color: var(--text-secondary);
  flex: 0 0 auto;
}
.rate-bar {
  flex: 1;
}

@media (max-width: 900px) {
  .phase {
    padding: var(--sp-4);
  }
  .figs {
    gap: var(--sp-6);
  }
}
</style>
