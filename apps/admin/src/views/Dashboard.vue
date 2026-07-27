<template>
  <div class="toolbar">
    <el-date-picker
      v-model="period"
      type="month"
      value-format="YYYY-MM"
      format="YYYY 年 M 月"
      placeholder="全部账期"
      clearable
      style="width: 170px"
      @change="load"
    />
    <el-button :loading="loading" @click="load">查询</el-button>
  </div>

  <el-row v-loading="loading" :gutter="16" class="cards">
    <el-col :xs="24" :sm="12" :md="6">
      <el-card><div class="stat-label">应收（元）</div><div class="stat-value">{{ summary.billAmount }}</div></el-card>
    </el-col>
    <el-col :xs="24" :sm="12" :md="6">
      <el-card><div class="stat-label">实收（元）</div><div class="stat-value ok">{{ summary.paidAmount }}</div></el-card>
    </el-col>
    <el-col :xs="24" :sm="12" :md="6">
      <el-card><div class="stat-label">收缴率</div><div class="stat-value">{{ summary.rate }}%</div></el-card>
    </el-col>
    <el-col :xs="24" :sm="12" :md="6">
      <el-card>
        <div class="stat-label">账单（笔）</div>
        <div class="stat-value">{{ summary.paidCount }} / {{ summary.billCount }}</div>
      </el-card>
    </el-col>
  </el-row>

  <el-card v-if="rowsData.length > 1">
    <template #header>各小区收缴情况</template>
    <el-table v-loading="loading" :data="rowsData">
      <el-table-column prop="name" label="小区" min-width="150" />
      <el-table-column prop="billAmount" label="应收（元）" width="130" />
      <el-table-column prop="paidAmount" label="实收（元）" width="130" />
      <el-table-column label="账单（笔）" width="110">
        <template #default="{ row }">{{ row.paidCount }} / {{ row.billCount }}</template>
      </el-table-column>
      <el-table-column label="收缴率" min-width="200">
        <template #default="{ row }">
          <el-progress :percentage="clampRate(row.rate)" :stroke-width="14" :color="row.rate >= 80 ? 'var(--success)' : row.rate >= 50 ? 'var(--warning)' : 'var(--danger-text)'" />
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-card v-if="rowsData.length <= 1">
    <div class="single-hint">
      <p class="sh-title">本月收缴情况</p>
      <p class="sh-desc">
        当前只有一个小区，各小区对比表已隐藏。可到
        <el-button text type="primary" size="small" @click="$router.push('/bills')">账单查询</el-button>
        查看每户的缴费与逾期明细。
      </p>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, qs } from '../api';
import { currentMonth } from '../composables';

interface Summary {
  billAmount: string;
  billCount: number;
  paidAmount: string;
  paidCount: number;
  rate: number;
}

const period = ref(currentMonth());
const summary = ref<Summary>({ billAmount: '0.00', billCount: 0, paidAmount: '0.00', paidCount: 0, rate: 0 });
const rowsData = ref<(Summary & { communityId: string; name: string })[]>([]);

const loading = ref(false);

/** 收缴率可能因退款/多缴超出 0~100，Element 的 el-progress 会直接报错 */
function clampRate(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const q = qs({ period: period.value });
    const [s, rows] = await Promise.all([
      api<Summary>(`/admin/stats/summary${q}`),
      api<(Summary & { communityId: string; name: string })[]>(`/admin/stats/by-community${q}`),
    ]);
    summary.value = s;
    rowsData.value = rows;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.single-hint {
  padding: var(--sp-4) 0;
}
.sh-title {
  margin: 0 0 var(--sp-1);
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
}
.sh-desc {
  margin: 0;
  font-size: var(--fs-12);
  color: var(--text-secondary);
}
.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.cards {
  margin-bottom: 16px;
}
.stat-label {
  color: var(--text-secondary);
  font-size: var(--fs-13);
}
.stat-value {
  font-size: var(--fs-28);
  font-weight: 800;
  color: var(--text-primary);
  margin-top: 6px;
}
.stat-value.ok {
  color: var(--success-text);
}
</style>
