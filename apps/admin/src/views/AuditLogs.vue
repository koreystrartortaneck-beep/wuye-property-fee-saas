<template>
  <el-card>
    <template #header>审计日志（只读，不可修改删除）</template>
    <div class="toolbar">
      <el-select v-model="filter.action" placeholder="操作类型" clearable style="width: 130px" @change="reload">
        <el-option v-for="(label, val) in AUDIT_ACTION_LABEL" :key="val" :label="label" :value="val" />
      </el-select>
      <el-select v-model="filter.communityId" placeholder="小区" clearable style="width: 160px" @change="reload">
        <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-input v-model="filter.resourceType" placeholder="对象类型" clearable style="width: 130px" @change="reload" />
      <el-input v-model="filter.resourceId" placeholder="对象 ID" clearable style="width: 160px" @change="reload" />
      <el-input v-model="filter.actorId" placeholder="操作人 ID" clearable style="width: 160px" @change="reload" />
      <el-button @click="reload">查询</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column label="时间" width="150">
        <template #default="{ row }">{{ dt(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="80">
        <template #default="{ row }">{{ AUDIT_ACTION_LABEL[row.action] || row.action }}</template>
      </el-table-column>
      <el-table-column label="操作人" width="150">
        <template #default="{ row }">
          <div>{{ AUDIT_ACTOR_LABEL[row.actorType] || row.actorType }}</div>
          <div class="sub">{{ row.actorId || '—' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="对象" min-width="200">
        <template #default="{ row }">
          <div>{{ row.resourceType }}</div>
          <div class="sub">{{ row.resourceId }}</div>
        </template>
      </el-table-column>
      <el-table-column label="原因" min-width="160">
        <template #default="{ row }">{{ row.reason || '—' }}</template>
      </el-table-column>
      <el-table-column label="详情" min-width="220">
        <template #default="{ row }">
          <el-button text type="primary" size="small" @click="showDetail(row)">查看</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination
      class="pager"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="20"
      :current-page="page"
      @current-change="(p: number) => { page = p; load(); }"
    />

    <el-dialog v-model="detailDialog" title="审计详情" width="600px">
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="请求 ID">{{ detail?.requestId || '—' }}</el-descriptions-item>
        <el-descriptions-item label="IP">{{ detail?.ip || '—' }}</el-descriptions-item>
        <el-descriptions-item label="User-Agent">{{ detail?.userAgent || '—' }}</el-descriptions-item>
      </el-descriptions>
      <div class="json-title">变更前</div>
      <pre class="json">{{ pretty(detail?.beforeSummary) }}</pre>
      <div class="json-title">变更后</div>
      <pre class="json">{{ pretty(detail?.afterSummary) }}</pre>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, qs, type Page } from '../api';
import { useCommunities } from '../composables';
import { AUDIT_ACTION_LABEL, AUDIT_ACTOR_LABEL, dt } from '../finance';

interface Log {
  id: string;
  action: string;
  actorType: string;
  actorId: string | null;
  resourceType: string;
  resourceId: string;
  reason: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  beforeSummary: unknown;
  afterSummary: unknown;
  createdAt: string;
}

const { communities } = useCommunities();
const filter = ref({ action: '', communityId: '', resourceType: '', resourceId: '', actorId: '' });
const rows = ref<Log[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const detailDialog = ref(false);
const detail = ref<Log | null>(null);

onMounted(load);

function reload() {
  page.value = 1;
  load();
}

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<Log>>(`/admin/audit-logs${qs({ ...filter.value, page: page.value, pageSize: 20 })}`);
    rows.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

function showDetail(row: Log) {
  detail.value = row;
  detailDialog.value = true;
}

function pretty(v: unknown): string {
  if (v === null || v === undefined) return '—';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
</script>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}
.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
.sub {
  color: #8a7f73;
  font-size: 12px;
}
.json-title {
  margin: 10px 0 4px;
  font-weight: 600;
  color: #102033;
}
.json {
  background: #f6f0e7;
  padding: 10px;
  border-radius: 6px;
  font-size: 12px;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
