<template>
  <el-card>
    <div class="toolbar">
      <el-select v-model="type" placeholder="通知类型" clearable style="width: 160px" @change="reload">
        <el-option label="出账通知" value="BILL_CREATED" />
        <el-option label="到期提醒" value="DUE_SOON" />
        <el-option label="逾期提醒" value="OVERDUE" />
      </el-select>
      <el-button @click="reload">查询</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column label="类型" width="110">
        <template #default="{ row }">{{ TYPE[row.type] }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'SENT' ? 'success' : row.status === 'FAILED' ? 'danger' : 'info'">
            {{ STATUS[row.status] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="channel" label="通道" width="130" />
      <el-table-column prop="billId" label="账单 ID" min-width="200" />
      <el-table-column prop="error" label="失败原因" min-width="160" />
      <el-table-column label="时间" width="160">
        <template #default="{ row }">{{ String(row.sentAt).replace('T', ' ').slice(0, 19) }}</template>
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
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, qs, type Page } from '../api';

interface Log {
  id: string;
  type: string;
  status: string;
  channel: string;
  billId: string | null;
  error: string | null;
  sentAt: string;
}

const TYPE: Record<string, string> = { BILL_CREATED: '出账通知', DUE_SOON: '到期提醒', OVERDUE: '逾期提醒' };
const STATUS: Record<string, string> = { SENT: '已发送', FAILED: '失败', SKIPPED: '跳过' };

const type = ref('');
const rows = ref<Log[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);

function reload() {
  page.value = 1;
  load();
}

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<Log>>(`/admin/notify-logs${qs({ type: type.value, page: page.value, pageSize: 20 })}`);
    rows.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
}
.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
</style>
