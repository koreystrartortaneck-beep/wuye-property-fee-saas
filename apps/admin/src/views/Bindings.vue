<template>
  <el-card>
    <div class="toolbar">
      <el-radio-group v-model="status" @change="reload">
        <el-radio-button value="PENDING">待审核</el-radio-button>
        <el-radio-button value="ACTIVE">已通过</el-radio-button>
        <el-radio-button value="REJECTED">已驳回</el-radio-button>
        <el-radio-button value="">全部</el-radio-button>
      </el-radio-group>
    </div>
    <el-table :data="rows" v-loading="loading">
      <el-table-column label="房屋" min-width="180">
        <template #default="{ row }">{{ row.house?.displayName }}（{{ row.house?.code }}）</template>
      </el-table-column>
      <el-table-column prop="applicantName" label="申请人" width="110" />
      <el-table-column label="关系" width="80">
        <template #default="{ row }">{{ RELATION[row.relation] }}</template>
      </el-table-column>
      <el-table-column label="手机号" width="130">
        <template #default="{ row }">{{ row.wxUser?.phone || '—' }}</template>
      </el-table-column>
      <el-table-column label="来源" width="100">
        <template #default="{ row }">{{ row.source === 'PHONE_MATCH' ? '手机号匹配' : '自助申请' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="TAG[row.status]">{{ STATUS[row.status] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="rejectReason" label="驳回原因" min-width="120" />
      <el-table-column label="操作" width="160">
        <template #default="{ row }">
          <template v-if="row.status === 'PENDING'">
            <el-button size="small" type="success" @click="review(row, true)">通过</el-button>
            <el-button size="small" type="danger" @click="openReject(row)">驳回</el-button>
          </template>
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

    <el-dialog v-model="rejectDialog" title="驳回申请" width="420px">
      <el-input v-model="rejectReason" placeholder="驳回原因（业主可见）" />
      <template #footer>
        <el-button @click="rejectDialog = false">取消</el-button>
        <el-button type="danger" @click="review(rejecting!, false)">确认驳回</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';

interface Binding {
  id: string;
  applicantName: string | null;
  relation: string;
  status: string;
  source: string;
  rejectReason: string | null;
  house?: { displayName: string; code: string };
  wxUser?: { phone: string | null };
}

const RELATION: Record<string, string> = { OWNER: '业主', FAMILY: '家属', TENANT: '租客' };
const STATUS: Record<string, string> = { PENDING: '待审核', ACTIVE: '已通过', REJECTED: '已驳回' };
const TAG: Record<string, 'warning' | 'success' | 'danger'> = { PENDING: 'warning', ACTIVE: 'success', REJECTED: 'danger' };

const status = ref('PENDING');
const rows = ref<Binding[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const rejectDialog = ref(false);
const rejectReason = ref('');
const rejecting = ref<Binding | null>(null);

function reload() {
  page.value = 1;
  load();
}

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<Binding>>(`/admin/bindings${qs({ status: status.value, page: page.value, pageSize: 20 })}`);
    rows.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

function openReject(row: Binding) {
  rejecting.value = row;
  rejectReason.value = '';
  rejectDialog.value = true;
}

async function review(row: Binding, approve: boolean) {
  await api(`/admin/bindings/${row.id}/review`, {
    method: 'POST',
    body: { approve, rejectReason: approve ? undefined : rejectReason.value || '未通过审核' },
  });
  ElMessage.success(approve ? '已通过' : '已驳回');
  rejectDialog.value = false;
  await load();
}

onMounted(load);
</script>

<style scoped>
.toolbar {
  margin-bottom: 14px;
}
.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
</style>
