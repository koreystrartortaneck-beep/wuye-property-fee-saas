<template>
  <el-card>
    <template #header>开票申请</template>
    <div class="toolbar">
      <el-select v-model="filter.communityId" placeholder="小区" clearable style="width: 160px" @change="reload">
        <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-select v-model="filter.status" placeholder="状态" clearable style="width: 130px" @change="reload">
        <el-option v-for="(label, val) in INVOICE_STATUS_LABEL" :key="val" :label="label" :value="val" />
      </el-select>
      <el-button @click="reload">查询</el-button>
      <span class="hint">本系统仅登记开票申请，不代开增值税发票。</span>
    </div>
    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="applicationNo" label="申请单号" min-width="170" />
      <el-table-column label="抬头" min-width="180">
        <template #default="{ row }">
          <div>{{ row.title }}</div>
          <div class="sub">{{ INVOICE_TITLE_TYPE_LABEL[row.titleType] }}{{ row.taxNo ? ' · ' + row.taxNo : '' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="金额（元）" width="100">
        <template #default="{ row }">{{ yuan(row.amount) }}</template>
      </el-table-column>
      <el-table-column label="交付" min-width="150">
        <template #default="{ row }">
          <div>{{ row.deliveryMethod }}</div>
          <div class="sub">{{ row.email || '' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="invoiceStatusTag(row.status)">{{ INVOICE_STATUS_LABEL[row.status] || row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="申请时间" width="150">
        <template #default="{ row }">{{ dt(row.appliedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="200">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'SUBMITTED' || row.status === 'PROCESSING'"
            size="small"
            @click="openProcess(row)"
          >处理</el-button>
          <el-button
            v-if="row.status === 'ISSUED'"
            size="small"
            type="warning"
            @click="openReverse(row)"
          >红冲</el-button>
          <span v-else-if="row.status === 'REVERSAL_REQUIRED'" class="warn">待红冲</span>
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

    <el-dialog v-model="dialog" title="处理开票申请" width="480px">
      <el-form label-width="90px">
        <el-form-item label="处理结果">
          <el-select v-model="pform.status" style="width: 100%">
            <el-option label="标记处理中" value="PROCESSING" />
            <el-option label="已开具" value="ISSUED" />
            <el-option label="驳回" value="REJECTED" />
          </el-select>
        </el-form-item>
        <template v-if="pform.status === 'ISSUED'">
          <el-form-item label="发票号"><el-input v-model="pform.invoiceNo" placeholder="外部开票系统发票号" /></el-form-item>
          <el-form-item label="发票链接"><el-input v-model="pform.invoiceUrl" placeholder="可选，PDF/图片链接" /></el-form-item>
        </template>
        <el-form-item v-if="pform.status === 'REJECTED'" label="驳回原因">
          <el-input v-model="pform.rejectReason" type="textarea" :rows="2" placeholder="必填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitProcess">确认</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, qs, type Page } from '../api';
import { useCommunities } from '../composables';
import { INVOICE_STATUS_LABEL, INVOICE_TITLE_TYPE_LABEL, invoiceStatusTag, yuan, dt } from '../finance';

interface Invoice {
  id: string;
  applicationNo: string;
  titleType: string;
  title: string;
  taxNo: string | null;
  amount: string;
  deliveryMethod: string;
  email: string | null;
  status: string;
  appliedAt: string;
}

const { communities } = useCommunities();
const filter = ref({ communityId: '', status: '' });
const rows = ref<Invoice[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const dialog = ref(false);
const submitting = ref(false);
const current = ref<Invoice | null>(null);
const pform = ref({ status: 'PROCESSING', invoiceNo: '', invoiceUrl: '', rejectReason: '' });

onMounted(load);

function reload() {
  page.value = 1;
  load();
}

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<Invoice>>(`/admin/invoices${qs({ ...filter.value, page: page.value, pageSize: 20 })}`);
    rows.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

function openProcess(row: Invoice) {
  current.value = row;
  pform.value = { status: 'PROCESSING', invoiceNo: '', invoiceUrl: '', rejectReason: '' };
  dialog.value = true;
}

async function submitProcess() {
  if (!current.value) return;
  const body: Record<string, string> = { status: pform.value.status };
  if (pform.value.status === 'ISSUED') {
    if (!pform.value.invoiceNo.trim()) return ElMessage.warning('请填写发票号');
    body.invoiceNo = pform.value.invoiceNo.trim();
    if (pform.value.invoiceUrl.trim()) body.invoiceUrl = pform.value.invoiceUrl.trim();
  }
  if (pform.value.status === 'REJECTED') {
    if (!pform.value.rejectReason.trim()) return ElMessage.warning('请填写驳回原因');
    body.rejectReason = pform.value.rejectReason.trim();
  }
  submitting.value = true;
  try {
    await api(`/admin/invoices/${current.value.id}/transition`, { method: 'POST', body });
    ElMessage.success('已处理');
    dialog.value = false;
    await load();
  } finally {
    submitting.value = false;
  }
}

async function openReverse(row: Invoice) {
  try {
    await ElMessageBox.confirm(`确认对申请单 ${row.applicationNo} 执行红冲（作废已开发票）？`, '红冲确认', {
      type: 'warning',
    });
  } catch {
    return;
  }
  await api(`/admin/invoices/${row.id}/transition`, { method: 'POST', body: { status: 'REVERSED' } });
  ElMessage.success('已红冲');
  await load();
}
</script>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
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
.hint {
  color: #8a7f73;
  font-size: 12px;
}
.warn {
  color: #e6a23c;
  font-size: 12px;
}
</style>
