<template>
  <div class="toolbar">
    <el-input v-model="period" placeholder="账期 YYYY-MM（留空为全部）" style="width: 220px" clearable @change="load" />
    <el-button @click="load">查询</el-button>
  </div>

  <el-row :gutter="16" class="cards">
    <el-col :span="6">
      <el-card><div class="stat-label">应收（元）</div><div class="stat-value">{{ summary.billAmount }}</div></el-card>
    </el-col>
    <el-col :span="6">
      <el-card><div class="stat-label">实收（元）</div><div class="stat-value ok">{{ summary.paidAmount }}</div></el-card>
    </el-col>
    <el-col :span="6">
      <el-card><div class="stat-label">收缴率</div><div class="stat-value">{{ summary.rate }}%</div></el-card>
    </el-col>
    <el-col :span="6">
      <el-card>
        <div class="stat-label">账单（笔）</div>
        <div class="stat-value">{{ summary.paidCount }} / {{ summary.billCount }}</div>
      </el-card>
    </el-col>
  </el-row>

  <el-card>
    <template #header>各小区收缴情况</template>
    <el-table :data="rowsData">
      <el-table-column prop="name" label="小区" min-width="150" />
      <el-table-column prop="billAmount" label="应收（元）" width="130" />
      <el-table-column prop="paidAmount" label="实收（元）" width="130" />
      <el-table-column label="账单（笔）" width="110">
        <template #default="{ row }">{{ row.paidCount }} / {{ row.billCount }}</template>
      </el-table-column>
      <el-table-column label="收缴率" min-width="200">
        <template #default="{ row }">
          <el-progress :percentage="row.rate" :stroke-width="14" :color="row.rate >= 80 ? 'var(--success)' : row.rate >= 50 ? 'var(--warning)' : 'var(--danger-text)'" />
        </template>
      </el-table-column>
    </el-table>
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

async function load() {
  const q = qs({ period: period.value });
  const [s, rows] = await Promise.all([
    api<Summary>(`/admin/stats/summary${q}`),
    api<(Summary & { communityId: string; name: string })[]>(`/admin/stats/by-community${q}`),
  ]);
  summary.value = s;
  rowsData.value = rows;
}

onMounted(load);
</script>

<style scoped>
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
