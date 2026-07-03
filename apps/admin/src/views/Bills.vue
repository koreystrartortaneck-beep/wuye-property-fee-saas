<template>
  <el-card class="mb">
    <template #header>手动出账 / 重跑批次</template>
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
      <span class="hint">重复触发同一账期是安全的：只会补生成缺失的账单，不会重复。</span>
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

  <el-card>
    <template #header>账单查询</template>
    <div class="toolbar">
      <el-select v-model="filter.communityId" placeholder="小区" clearable style="width: 160px" @change="reload">
        <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-input v-model="filter.period" placeholder="账期 YYYY-MM" style="width: 140px" clearable @change="reload" />
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
      <el-table-column prop="amount" label="金额（元）" width="110" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'PAID' ? 'success' : row.status === 'UNPAID' ? 'warning' : 'info'">
            {{ BILL_STATUS_LABEL[row.status] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="到期日" width="110">
        <template #default="{ row }">{{ String(row.dueDate).slice(0, 10) }}</template>
      </el-table-column>
      <el-table-column label="缴费时间" width="150">
        <template #default="{ row }">{{ row.paidAt ? String(row.paidAt).replace('T', ' ').slice(0, 16) : '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="90">
        <template #default="{ row }">
          <el-popconfirm v-if="row.status === 'UNPAID'" title="确认作废该账单？" @confirm="cancel(row)">
            <template #reference>
              <el-button size="small" type="danger">作废</el-button>
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
      @current-change="(p: number) => { page = p; loadBills(); }"
    />
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';
import { BILL_STATUS_LABEL, RULE_TYPE_LABEL, currentMonth, useCommunities } from '../composables';

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

const { communities } = useCommunities();
const rules = ref<Rule[]>([]);
const runs = ref<Run[]>([]);
const runForm = ref({ ruleId: '', period: currentMonth() });
const running = ref(false);

const filter = ref({ communityId: '', period: '', status: '' });
const bills = ref<Bill[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);

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
  await Promise.all([loadRuns(), loadBills()]);
});

async function loadRuns() {
  const data = await api<Page<Run>>('/admin/bill-runs?pageSize=20');
  runs.value = data.list;
}

async function triggerRun() {
  if (!runForm.value.ruleId) return ElMessage.warning('请选择规则');
  running.value = true;
  try {
    const res = await api<{ generated: number; skipped: number }>('/admin/bill-runs', {
      method: 'POST',
      body: runForm.value,
    });
    ElMessage.success(`出账完成：生成 ${res.generated}，跳过 ${res.skipped}`);
    await Promise.all([loadRuns(), loadBills()]);
  } finally {
    running.value = false;
  }
}

async function rerun(row: Run) {
  await api('/admin/bill-runs', { method: 'POST', body: { ruleId: row.ruleId, period: row.period } });
  ElMessage.success('已重跑');
  await Promise.all([loadRuns(), loadBills()]);
}

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

async function cancel(row: Bill) {
  await api(`/admin/bills/${row.id}/cancel`, { method: 'POST' });
  ElMessage.success('已作废');
  await loadBills();
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
  gap: 10px;
  margin-bottom: 14px;
}
.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
.hint {
  color: #8a7f73;
  font-size: 12px;
  margin-left: 12px;
}
.skip-text {
  color: #c45656;
  font-size: 12px;
}
</style>
