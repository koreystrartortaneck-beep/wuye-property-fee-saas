<template>
  <el-card class="mb">
    <template #header>手动出账 / 重跑批次（生成草稿批次，发布后业主可见）</template>
    <el-form inline>
      <el-form-item label="规则">
        <el-select v-model="runForm.ruleId" placeholder="选择规则" style="width: 260px">
          <el-option v-for="r in rules" :key="r.id" :label="`${r.name}（${RULE_TYPE_LABEL[r.ruleType]}）`" :value="r.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="账期">
        <el-input v-model="runForm.period" placeholder="YYYY-MM" style="width: 130px" />
      </el-form-item>
      <el-button type="primary" :loading="running" @click="triggerRun">出账</el-button>
      <span class="hint">重复触发同一账期是安全的：只补生成缺失的账单，不会重复。</span>
    </el-form>

    <el-table :data="runs" size="small" class="mt">
      <el-table-column label="规则" min-width="140">
        <template #default="{ row }">{{ row.rule?.name }}</template>
      </el-table-column>
      <el-table-column prop="period" label="账期" width="100" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'DONE' ? 'success' : row.status === 'FAILED' ? 'danger' : 'warning'">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="generated" label="生成" width="70" />
      <el-table-column prop="skipped" label="跳过" width="70" />
      <el-table-column label="跳过明细" min-width="220">
        <template #default="{ row }">
          <span v-if="row.skipped > 0 || row.status === 'FAILED'" class="skip-text">{{ skipText(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90">
        <template #default="{ row }">
          <el-button size="small" @click="rerun(row)">重跑</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-card class="mb">
    <template #header>账单导入（.csv / .xlsx，先预览校验，确认后落草稿批次）</template>
    <el-form inline>
      <el-form-item label="小区">
        <el-select v-model="importForm.communityId" placeholder="小区" style="width: 170px">
          <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="账期"><el-input v-model="importForm.period" placeholder="YYYY-MM" style="width: 120px" /></el-form-item>
      <el-form-item label="批次标题"><el-input v-model="importForm.title" placeholder="可选" style="width: 150px" /></el-form-item>
      <el-form-item>
        <el-upload
          :auto-upload="false"
          :show-file-list="true"
          :limit="1"
          accept=".csv,.xlsx"
          :on-change="onFilePick"
          :on-remove="() => (importFile = null)"
        >
          <el-button>选择文件</el-button>
        </el-upload>
      </el-form-item>
      <el-button :loading="previewing" :disabled="!canPreview" @click="doPreview">预览校验</el-button>
    </el-form>

    <div v-if="preview" class="preview">
      <el-alert
        :type="preview.summary.invalid > 0 ? 'warning' : 'success'"
        :closable="false"
        :title="`共 ${preview.summary.total} 行：有效 ${preview.summary.valid}，无效 ${preview.summary.invalid}，合计金额 ¥${preview.summary.totalAmount}`"
      />
      <el-table :data="preview.rows" size="small" max-height="300" class="mt">
        <el-table-column prop="rowNo" label="行号" width="70" />
        <el-table-column prop="houseCode" label="房号" min-width="120" />
        <el-table-column prop="title" label="费用" min-width="120" />
        <el-table-column prop="amount" label="金额" width="90" />
        <el-table-column label="校验" min-width="220">
          <template #default="{ row }">
            <el-tag v-if="row.valid" type="success" size="small">通过</el-tag>
            <span v-else class="skip-text">{{ (row.issues || []).map((i: any) => i.message).join('；') }}</span>
          </template>
        </el-table-column>
      </el-table>
      <div class="acts">
        <el-button
          type="primary"
          :loading="confirming"
          :disabled="preview.summary.valid === 0"
          @click="doConfirm"
        >确认导入（生成草稿批次）</el-button>
        <span class="hint">无效行不会被导入；确认后需在下方批次中「发布」才对业主可见。</span>
      </div>
    </div>
  </el-card>

  <el-card class="mb">
    <template #header>账单批次</template>
    <div class="toolbar">
      <el-select v-model="batchFilter.communityId" placeholder="小区" clearable style="width: 160px" @change="loadBatches">
        <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-select v-model="batchFilter.status" placeholder="状态" clearable style="width: 120px" @change="loadBatches">
        <el-option v-for="(label, val) in BILL_BATCH_STATUS_LABEL" :key="val" :label="label" :value="val" />
      </el-select>
      <el-button @click="loadBatches">查询</el-button>
    </div>
    <el-table :data="batches" size="small">
      <el-table-column prop="batchNo" label="批次号" min-width="150" />
      <el-table-column prop="period" label="账期" width="90" />
      <el-table-column label="来源" width="90">
        <template #default="{ row }">{{ BILL_SOURCE_LABEL[row.source] || row.source }}</template>
      </el-table-column>
      <el-table-column label="行数（有效/无效）" width="140">
        <template #default="{ row }">{{ row.validRows }} / {{ row.invalidRows }}</template>
      </el-table-column>
      <el-table-column label="金额（元）" width="100">
        <template #default="{ row }">{{ yuan(row.totalAmount) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'PUBLISHED' ? 'success' : row.status === 'FAILED' || row.status === 'CANCELED' ? 'info' : 'warning'">
            {{ BILL_BATCH_STATUS_LABEL[row.status] || row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'DRAFT' || row.status === 'READY'"
            size="small"
            type="primary"
            @click="openPublish(row)"
          >发布</el-button>
          <el-button size="small" @click="viewBatchBills(row)">查看账单</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-card>
    <template #header>账单查询</template>
    <div class="toolbar">
      <el-select v-model="filter.communityId" placeholder="小区" clearable style="width: 160px" @change="reload">
        <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-input v-model="filter.period" placeholder="账期 YYYY-MM" style="width: 140px" clearable @change="reload" />
      <el-input v-model="filter.batchId" placeholder="批次 ID" style="width: 150px" clearable @change="reload" />
      <el-select v-model="filter.status" placeholder="状态" clearable style="width: 120px" @change="reload">
        <el-option v-for="(label, val) in BILL_STATUS_LABEL" :key="val" :label="label" :value="val" />
      </el-select>
      <el-button @click="reload">查询</el-button>
    </div>
    <el-table :data="bills" v-loading="loading" size="small">
      <el-table-column label="房屋" min-width="150">
        <template #default="{ row }">{{ row.house?.displayName }}</template>
      </el-table-column>
      <el-table-column prop="title" label="账单" min-width="160" />
      <el-table-column label="金额（元）" width="100">
        <template #default="{ row }">{{ yuan(row.amount) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="billStatusTag(row.status)">{{ BILL_STATUS_LABEL[row.status] || row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="到期日" width="110">
        <template #default="{ row }">{{ day(row.dueDate) }}</template>
      </el-table-column>
      <el-table-column label="缴费时间" width="150">
        <template #default="{ row }">{{ dt(row.paidAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.status === 'UNPAID'" size="small" type="danger" @click="openCancel(row)">作废</el-button>
          <el-button v-if="row.status === 'CANCELED' || row.status === 'REFUNDED'" size="small" @click="openReissue(row)">重开</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination
      class="pager"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="20"
      :current-page="page"
      @current-change="(p: number) => { page = p; loadBills(); }"
    />
  </el-card>

  <!-- 发布批次 -->
  <el-dialog v-model="publishDialog" title="发布批次" width="440px">
    <el-form label-width="80px">
      <el-form-item label="批次号"><span>{{ currentBatch?.batchNo }}</span></el-form-item>
      <el-form-item label="有效账单"><span>{{ currentBatch?.validRows }} 条，合计 ¥{{ yuan(currentBatch?.totalAmount) }}</span></el-form-item>
      <el-form-item label="备注"><el-input v-model="publishReason" placeholder="可选" /></el-form-item>
    </el-form>
    <el-alert type="warning" :closable="false" title="发布后账单业务字段冻结、对业主可见并可缴费，不可撤销。" />
    <template #footer>
      <el-button @click="publishDialog = false">取消</el-button>
      <el-button type="primary" :loading="publishing" @click="doPublish">确认发布</el-button>
    </template>
  </el-dialog>

  <!-- 作废 / 重开 原因 -->
  <el-dialog v-model="reasonDialog" :title="reasonAction === 'cancel' ? '作废账单' : '重开账单'" width="440px">
    <el-form label-width="70px">
      <el-form-item label="账单"><span>{{ currentBill?.title }}（¥{{ yuan(currentBill?.amount) }}）</span></el-form-item>
      <el-form-item label="原因"><el-input v-model="reasonText" type="textarea" :rows="2" placeholder="必填，记入审计" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="reasonDialog = false">取消</el-button>
      <el-button :type="reasonAction === 'cancel' ? 'danger' : 'primary'" :loading="reasonSubmitting" @click="submitReason">
        确认{{ reasonAction === 'cancel' ? '作废' : '重开' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, type UploadFile } from 'element-plus';
import { api, qs, uploadForm, type Page } from '../api';
import { RULE_TYPE_LABEL, currentMonth, useCommunities } from '../composables';
import {
  BILL_STATUS_LABEL,
  BILL_BATCH_STATUS_LABEL,
  BILL_SOURCE_LABEL,
  billStatusTag,
  yuan,
  dt,
  day,
  genRequestId,
  buildReasonPayload,
} from '../finance';

interface Rule {
  id: string;
  name: string;
  ruleType: string;
}
interface Run {
  id: string;
  ruleId: string;
  period: string;
  status: string;
  generated: number;
  skipped: number;
  skippedDetail: { code: string; reason: string }[] | null;
  rule?: { name: string };
}
interface Bill {
  id: string;
  title: string;
  amount: string;
  status: string;
  dueDate: string;
  paidAt: string | null;
  house?: { displayName: string };
}
interface Batch {
  id: string;
  batchNo: string;
  period: string;
  source: string;
  validRows: number;
  invalidRows: number;
  totalAmount: string;
  status: string;
}
interface PreviewRow {
  rowNo: number;
  houseCode: string;
  title: string;
  amount: string;
  valid: boolean;
  issues: { code: string; message: string }[];
}
interface Preview {
  summary: { total: number; valid: number; invalid: number; totalAmount: string };
  rows: PreviewRow[];
}

const { communities } = useCommunities();
const rules = ref<Rule[]>([]);
const runs = ref<Run[]>([]);
const runForm = ref({ ruleId: '', period: currentMonth() });
const running = ref(false);

// 导入
const importForm = ref({ communityId: '', period: currentMonth(), title: '' });
const importFile = ref<File | null>(null);
const preview = ref<Preview | null>(null);
const previewing = ref(false);
const confirming = ref(false);
const importRequestId = ref('');
const canPreview = computed(() => !!importFile.value && !!importForm.value.communityId && !!importForm.value.period);

// 批次
const batchFilter = ref({ communityId: '', status: '' });
const batches = ref<Batch[]>([]);
const publishDialog = ref(false);
const publishing = ref(false);
const publishReason = ref('');
const currentBatch = ref<Batch | null>(null);

// 账单
const filter = ref({ communityId: '', period: '', batchId: '', status: '' });
const bills = ref<Bill[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);

// 作废/重开
const reasonDialog = ref(false);
const reasonAction = ref<'cancel' | 'reissue'>('cancel');
const reasonText = ref('');
const reasonSubmitting = ref(false);
const currentBill = ref<Bill | null>(null);

const REASON: Record<string, string> = {
  AREA_MISSING: '缺面积',
  METER_READING_MISSING: '缺抄表读数',
  SHARE_POOL_MISSING: '缺公摊总额',
  FORMULA_INVALID: '公式计算异常',
};

function skipText(row: Run): string {
  const detail = row.skippedDetail ?? [];
  return detail.map((d) => `${d.code === '*' ? '全部' : d.code}:${REASON[d.reason] ?? d.reason}`).join('；');
}

onMounted(async () => {
  const data = await api<Page<Rule>>(`/admin/fee-rules${qs({ pageSize: 200 })}`);
  rules.value = data.list;
  await Promise.all([loadRuns(), loadBatches(), loadBills()]);
});

async function loadRuns() {
  const data = await api<Page<Run>>('/admin/bill-runs?pageSize=20');
  runs.value = data.list;
}

async function triggerRun() {
  if (!runForm.value.ruleId) return ElMessage.warning('请选择规则');
  running.value = true;
  try {
    const res = await api<{ generated: number; skipped: number }>('/admin/bill-runs', { method: 'POST', body: runForm.value });
    ElMessage.success(`出账完成：生成 ${res.generated}，跳过 ${res.skipped}`);
    await Promise.all([loadRuns(), loadBatches(), loadBills()]);
  } finally {
    running.value = false;
  }
}

async function rerun(row: Run) {
  await api('/admin/bill-runs', { method: 'POST', body: { ruleId: row.ruleId, period: row.period } });
  ElMessage.success('已重跑');
  await Promise.all([loadRuns(), loadBatches(), loadBills()]);
}

// ---- 导入 ----
function onFilePick(file: UploadFile) {
  importFile.value = (file.raw as File) || null;
  preview.value = null;
}

async function doPreview() {
  if (!importFile.value) return;
  previewing.value = true;
  try {
    preview.value = await uploadForm<Preview>('/admin/bill-imports/preview', importFile.value, {
      communityId: importForm.value.communityId,
      period: importForm.value.period,
      title: importForm.value.title || undefined,
    });
    importRequestId.value = genRequestId('import');
  } finally {
    previewing.value = false;
  }
}

async function doConfirm() {
  if (!importFile.value) return;
  confirming.value = true;
  try {
    const res = await uploadForm<{ batchId: string; status: string }>('/admin/bill-imports/confirm', importFile.value, {
      communityId: importForm.value.communityId,
      period: importForm.value.period,
      title: importForm.value.title || undefined,
      requestId: importRequestId.value,
    });
    ElMessage.success(`已生成草稿批次（${res.status}），请在批次列表发布`);
    preview.value = null;
    importFile.value = null;
    await loadBatches();
  } finally {
    confirming.value = false;
  }
}

// ---- 批次 ----
async function loadBatches() {
  const data = await api<Page<Batch>>(`/admin/bill-batches${qs({ ...batchFilter.value, pageSize: 50 })}`);
  batches.value = data.list;
}

function openPublish(row: Batch) {
  currentBatch.value = row;
  publishReason.value = '';
  publishDialog.value = true;
}

async function doPublish() {
  if (!currentBatch.value) return;
  publishing.value = true;
  try {
    await api(`/admin/bill-batches/${currentBatch.value.id}/publish`, {
      method: 'POST',
      body: { requestId: genRequestId('publish'), reason: publishReason.value || undefined },
    });
    ElMessage.success('已发布');
    publishDialog.value = false;
    await Promise.all([loadBatches(), loadBills()]);
  } finally {
    publishing.value = false;
  }
}

function viewBatchBills(row: Batch) {
  filter.value = { communityId: '', period: '', batchId: row.id, status: '' };
  reload();
}

// ---- 账单 ----
function reload() {
  page.value = 1;
  loadBills();
}

async function loadBills() {
  loading.value = true;
  try {
    const data = await api<Page<Bill>>(`/admin/bills${qs({ ...filter.value, page: page.value, pageSize: 20 })}`);
    bills.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

function openCancel(row: Bill) {
  currentBill.value = row;
  reasonAction.value = 'cancel';
  reasonText.value = '';
  reasonDialog.value = true;
}

function openReissue(row: Bill) {
  currentBill.value = row;
  reasonAction.value = 'reissue';
  reasonText.value = '';
  reasonDialog.value = true;
}

async function submitReason() {
  if (!currentBill.value) return;
  let body;
  try {
    body = buildReasonPayload(reasonText.value);
  } catch (e) {
    return ElMessage.warning((e as Error).message);
  }
  reasonSubmitting.value = true;
  try {
    const path = reasonAction.value === 'cancel' ? 'cancel' : 'reissue';
    await api(`/admin/bills/${currentBill.value.id}/${path}`, { method: 'POST', body });
    ElMessage.success(reasonAction.value === 'cancel' ? '已作废' : '已重开');
    reasonDialog.value = false;
    await loadBills();
  } finally {
    reasonSubmitting.value = false;
  }
}
</script>

<style scoped>
.mb {
  margin-bottom: 16px;
}
.mt {
  margin-top: 8px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}
.acts {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
.hint {
  color: #8a7f73;
  font-size: 12px;
}
.skip-text {
  color: #c45656;
  font-size: 12px;
}
.preview {
  margin-top: 14px;
}
</style>
