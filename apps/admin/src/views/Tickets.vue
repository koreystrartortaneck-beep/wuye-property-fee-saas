<template>
  <el-card>
    <div class="toolbar">
      <el-select v-model="filter.communityId" placeholder="小区" clearable style="width: 160px" @change="reload">
        <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-select v-model="filter.type" placeholder="类型" clearable style="width: 120px" @change="reload">
        <el-option v-for="(label, val) in TYPE" :key="val" :label="label" :value="val" />
      </el-select>
      <el-radio-group v-model="filter.status" @change="reload">
        <el-radio-button value="PENDING">待受理</el-radio-button>
        <el-radio-button value="PROCESSING">处理中</el-radio-button>
        <el-radio-button value="DONE">已办结</el-radio-button>
        <el-radio-button value="">全部</el-radio-button>
      </el-radio-group>
    </div>

    <el-table :data="rows" v-loading="loading">
      <el-table-column label="类型" width="90">
        <template #default="{ row }">
          <el-tag :type="row.type === 'REPAIR' ? 'warning' : row.type === 'COMPLAINT' ? 'danger' : 'info'">
            {{ TYPE[row.type] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="房屋" width="150">
        <template #default="{ row }">{{ row.house?.displayName }}</template>
      </el-table-column>
      <el-table-column prop="content" label="内容" min-width="200" show-overflow-tooltip />
      <el-table-column label="图片" width="120">
        <template #default="{ row }">
          <el-image
            v-for="(img, i) in row.images || []"
            :key="i"
            :src="imgUrl(img)"
            :preview-src-list="(row.images || []).map(imgUrl)"
            fit="cover"
            style="width: 32px; height: 32px; margin-right: 4px; border-radius: 4px"
          />
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="STATUS_TAG[row.status]">{{ STATUS[row.status] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="assigneeName" label="负责人" width="90" />
      <el-table-column label="评分" width="80">
        <template #default="{ row }">{{ row.rating ? '★'.repeat(row.rating) : '—' }}</template>
      </el-table-column>
      <el-table-column label="提交时间" width="150">
        <template #default="{ row }">{{ String(row.createdAt).replace('T', ' ').slice(0, 16) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="200">
        <template #default="{ row }">
          <el-button v-if="row.status === 'PENDING'" size="small" type="primary" @click="openProcess(row)">受理</el-button>
          <el-button v-if="row.status === 'PROCESSING'" size="small" type="success" @click="openDone(row)">办结</el-button>
          <el-popconfirm v-if="row.status === 'PENDING' || row.status === 'PROCESSING'" title="确认关闭该工单？" @confirm="close(row)">
            <template #reference>
              <el-button size="small">关闭</el-button>
            </template>
          </el-popconfirm>
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

    <el-dialog v-model="processDialog" title="受理派单" width="380px">
      <el-input v-model="assigneeName" placeholder="维修/处理负责人姓名" />
      <template #footer>
        <el-button @click="processDialog = false">取消</el-button>
        <el-button type="primary" @click="doProcess">确认受理</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="doneDialog" title="办结工单" width="440px">
      <el-input v-model="replyContent" type="textarea" :rows="4" placeholder="处理结果说明（业主可见）" />
      <template #footer>
        <el-button @click="doneDialog = false">取消</el-button>
        <el-button type="success" @click="doDone">确认办结</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';
import { useCommunities } from '../composables';

interface Ticket {
  id: string;
  type: string;
  content: string;
  images: string[];
  status: string;
  assigneeName: string | null;
  rating: number | null;
  createdAt: string;
  house?: { displayName: string };
}

const TYPE: Record<string, string> = { REPAIR: '报修', COMPLAINT: '投诉', SUGGESTION: '建议' };
const STATUS: Record<string, string> = { PENDING: '待受理', PROCESSING: '处理中', DONE: '已办结', CLOSED: '已关闭' };
const STATUS_TAG: Record<string, 'warning' | 'primary' | 'success' | 'info'> = {
  PENDING: 'warning', PROCESSING: 'primary', DONE: 'success', CLOSED: 'info',
};

const { communities } = useCommunities();
const filter = ref({ communityId: '', type: '', status: 'PENDING' });
const rows = ref<Ticket[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);

const processDialog = ref(false);
const doneDialog = ref(false);
const assigneeName = ref('');
const replyContent = ref('');
const current = ref<Ticket | null>(null);

/** 上传图片相对路径 → 可访问 URL（走同源 /wuye/uploads 或 dev 代理） */
function imgUrl(rel: string): string {
  const base = (import.meta as any).env?.VITE_API_BASE || '/api/v1';
  return base.replace(/\/api\/v1$/, '') + rel;
}

function reload() {
  page.value = 1;
  load();
}

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<Ticket>>(`/admin/tickets${qs({ ...filter.value, page: page.value, pageSize: 20 })}`);
    rows.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

function openProcess(row: Ticket) {
  current.value = row;
  assigneeName.value = '';
  processDialog.value = true;
}

async function doProcess() {
  if (!assigneeName.value.trim()) return ElMessage.warning('请填写负责人');
  await api(`/admin/tickets/${current.value!.id}/process`, { method: 'POST', body: { assigneeName: assigneeName.value } });
  ElMessage.success('已受理');
  processDialog.value = false;
  await load();
}

function openDone(row: Ticket) {
  current.value = row;
  replyContent.value = '';
  doneDialog.value = true;
}

async function doDone() {
  if (!replyContent.value.trim()) return ElMessage.warning('请填写处理结果');
  await api(`/admin/tickets/${current.value!.id}/done`, { method: 'POST', body: { replyContent: replyContent.value } });
  ElMessage.success('已办结');
  doneDialog.value = false;
  await load();
}

async function close(row: Ticket) {
  await api(`/admin/tickets/${row.id}/close`, { method: 'POST' });
  ElMessage.success('已关闭');
  await load();
}

onMounted(load);
</script>

<style scoped>
.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
</style>
