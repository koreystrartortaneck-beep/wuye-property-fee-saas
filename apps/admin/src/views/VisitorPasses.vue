<template>
  <el-card class="mb">
    <template #header>输码核销</template>
    <div class="verify-row">
      <el-input v-model="verifyCode" placeholder="输入访客的 6 位通行码" maxlength="6" style="width: 240px" @keyup.enter="findByCode" />
      <el-button type="primary" @click="findByCode">查验</el-button>
      <template v-if="found">
        <span class="found-info">
          {{ found.visitorName }} · {{ found.house?.displayName }} · {{ String(found.visitDate).slice(0, 10) }}
          <el-tag :type="TAG[found.status]" class="ml">{{ STATUS[found.status] }}</el-tag>
        </span>
        <el-button v-if="found.status === 'ACTIVE'" type="success" @click="verify(found)">放行核销</el-button>
      </template>
    </div>
  </el-card>

  <el-card>
    <div class="toolbar">
      <el-select v-model="filter.communityId" placeholder="小区" clearable style="width: 160px" @change="reload">
        <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-date-picker v-model="filter.date" type="date" placeholder="到访日期" value-format="YYYY-MM-DD" @change="reload" />
      <el-button @click="reload">查询</el-button>
    </div>
    <el-table :data="rows" v-loading="loading">
      <el-table-column prop="code" label="通行码" width="100" />
      <el-table-column prop="visitorName" label="访客" width="100" />
      <el-table-column prop="visitorPhone" label="电话" width="130" />
      <el-table-column prop="plateNo" label="车牌" width="110" />
      <el-table-column label="到访房屋" min-width="150">
        <template #default="{ row }">{{ row.house?.displayName }}</template>
      </el-table-column>
      <el-table-column label="到访日期" width="110">
        <template #default="{ row }">{{ String(row.visitDate).slice(0, 10) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="TAG[row.status]">{{ STATUS[row.status] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="110">
        <template #default="{ row }">
          <el-button v-if="row.status === 'ACTIVE'" size="small" type="success" @click="verify(row)">放行核销</el-button>
          <span v-else-if="row.usedAt" class="used-at">{{ String(row.usedAt).replace('T', ' ').slice(5, 16) }}</span>
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
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';
import { useCommunities } from '../composables';

interface Pass {
  id: string;
  code: string;
  visitorName: string;
  visitorPhone: string | null;
  plateNo: string | null;
  visitDate: string;
  status: string;
  usedAt: string | null;
  house?: { displayName: string };
}

const STATUS: Record<string, string> = { ACTIVE: '有效', USED: '已核销', EXPIRED: '已过期', CANCELED: '已取消' };
const TAG: Record<string, 'success' | 'info' | 'warning' | 'danger'> = {
  ACTIVE: 'success', USED: 'info', EXPIRED: 'warning', CANCELED: 'danger',
};

const { communities } = useCommunities();
const today = new Date();
const filter = ref({
  communityId: '',
  date: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
});
const rows = ref<Pass[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const verifyCode = ref('');
const found = ref<Pass | null>(null);

function reload() {
  page.value = 1;
  load();
}

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<Pass>>(`/admin/visitor-passes${qs({ ...filter.value, page: page.value, pageSize: 20 })}`);
    rows.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

async function findByCode() {
  if (!/^\d{6}$/.test(verifyCode.value)) return ElMessage.warning('请输入 6 位数字通行码');
  const data = await api<Page<Pass>>(`/admin/visitor-passes${qs({ code: verifyCode.value })}`);
  if (data.total === 0) {
    found.value = null;
    ElMessage.error('未找到该通行码');
    return;
  }
  found.value = data.list[0];
}

async function verify(pass: Pass) {
  await api(`/admin/visitor-passes/${pass.id}/verify`, { method: 'POST' });
  ElMessage.success(`已放行：${pass.visitorName}`);
  if (found.value?.id === pass.id) found.value = { ...found.value, status: 'USED' };
  await load();
}

onMounted(load);
</script>

<style scoped>
.mb {
  margin-bottom: 16px;
}
.verify-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.found-info {
  color: #102033;
  font-size: 14px;
}
.ml {
  margin-left: 6px;
}
.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
}
.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
.used-at {
  color: #999;
  font-size: 12px;
}
</style>
