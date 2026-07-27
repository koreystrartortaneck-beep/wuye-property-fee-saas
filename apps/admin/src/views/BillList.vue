<template>
  <el-card>
    <div class="toolbar">
      <div class="field">
        <label>账期</label>
        <el-date-picker
          v-model="filter.period"
          type="month"
          value-format="YYYY-MM"
          format="YYYY 年 M 月"
          placeholder="全部账期"
          clearable
          style="width: 150px"
          @change="reload"
        />
      </div>
      <div class="field">
        <label>状态</label>
        <el-select v-model="filter.status" placeholder="全部状态" clearable style="width: 130px" @change="reload">
          <el-option label="待缴" value="UNPAID" />
          <el-option label="已缴" value="PAID" />
          <el-option label="已退款" value="REFUNDED" />
          <el-option label="已作废" value="CANCELED" />
          <el-option label="退款中" value="REFUNDING" />
          <el-option label="未发布" value="DRAFT" />
        </el-select>
      </div>
      <div v-if="communities.length > 1" class="field">
        <label>小区</label>
        <el-select v-model="filter.communityId" placeholder="全部小区" clearable style="width: 150px" @change="reload">
          <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </div>
      <div class="toolbar-right">
        <el-button :disabled="!bills.length" size="small" @click="doExport">导出本页</el-button>
        <span class="summary">
          共 <b class="num">{{ total }}</b> 笔
          <template v-if="pageAmount !== '0.00'"> · 本页合计 <b class="num">¥{{ pageAmount }}</b></template>
        </span>
      </div>
    </div>

    <el-table v-loading="loading" :data="bills" class="bill-table">
      <el-table-column label="房屋 / 费用" min-width="240">
        <template #default="{ row }">
          <div class="cell-main">{{ row.house?.displayName || '未知房屋' }}</div>
          <div class="cell-sub">{{ row.title }}</div>
        </template>
      </el-table-column>

      <el-table-column label="怎么算的" min-width="170">
        <template #default="{ row }"><span class="calc">{{ calcText(row) }}</span></template>
      </el-table-column>

      <el-table-column label="金额（元）" width="120" align="right">
        <template #default="{ row }"><span class="num money">{{ yuan(row.amount) }}</span></template>
      </el-table-column>

      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag
            :type="row.status === 'UNPAID' && isOverdue(row) ? 'danger' : billStatusTag(row.status)"
            size="small"
            effect="light"
          >
            {{ statusText(row) }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="时间" min-width="150">
        <template #default="{ row }">
          <div v-if="row.status === 'PAID' && row.paidAt" class="cell-sub">缴于 {{ day(row.paidAt) }}</div>
          <div v-else-if="row.status === 'UNPAID'" class="cell-sub" :class="{ overdue: isOverdue(row) }">
            {{ isOverdue(row) ? `已逾期 ${overdueDays(row)} 天` : `到期 ${day(row.dueDate)}` }}
          </div>
          <div v-else class="cell-sub">—</div>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.status === 'UNPAID'" size="small" text type="danger" @click="openCancel(row)">
            作废
          </el-button>
          <el-button
            v-if="row.status === 'CANCELED' || row.status === 'REFUNDED'"
            size="small"
            text
            @click="openReissue(row)"
          >重开</el-button>
        </template>
      </el-table-column>

      <template #empty>
        <div class="empty">
          <p>{{ filter.period || filter.status ? '当前条件下没有账单' : '还没有账单' }}</p>
          <el-button v-if="!filter.period && !filter.status" type="primary" text @click="router.push('/bill-run')">
            去出账 →
          </el-button>
        </div>
      </template>
    </el-table>

    <el-pagination
      layout="total, prev, pager, next"
      :total="total"
      :page-size="20"
      :current-page="page"
      @current-change="(p: number) => { page = p; loadBills(); }"
    />
  </el-card>

  <!-- 作废 / 重开 -->
  <el-dialog v-model="reasonDialog" :title="reasonAction === 'cancel' ? '作废账单' : '重新开具账单'" width="min(440px, 92vw)">
    <div v-if="currentBill" class="confirm-target">
      <div class="confirm-line">
        <span class="confirm-k">房屋</span><span class="confirm-v">{{ currentBill.house?.displayName || '—' }}</span>
      </div>
      <div class="confirm-line">
        <span class="confirm-k">费用</span><span class="confirm-v">{{ currentBill.title }}</span>
      </div>
      <div class="confirm-line">
        <span class="confirm-k">金额</span><span class="confirm-v num money">¥{{ yuan(currentBill.amount) }}</span>
      </div>
    </div>
    <el-alert
      :type="reasonAction === 'cancel' ? 'warning' : 'info'"
      :closable="false"
      show-icon
      :title="
        reasonAction === 'cancel'
          ? '作废后业主端将显示「已作废」，不可再缴费；如需恢复可用「重开」生成一张新账单。'
          : '将按原房屋与金额生成一张新的待缴账单，原账单保留记录。'
      "
      style="margin: 12px 0"
    />
    <el-form label-width="60px">
      <el-form-item label="原因">
        <el-input v-model="reasonText" type="textarea" :rows="2" placeholder="必填，记入操作留痕" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="reasonDialog = false">取消</el-button>
      <el-button
        :type="reasonAction === 'cancel' ? 'danger' : 'primary'"
        :loading="reasonSubmitting"
        @click="submitReason"
      >确认{{ reasonAction === 'cancel' ? '作废' : '重开' }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';
import { useCommunities } from '../composables';
import { billStatusTag, buildReasonPayload, day, genRequestId, shanghaiToday, yuan } from '../finance';
import { exportCsv } from '../export';

interface Bill {
  id: string;
  title: string;
  amount: string;
  status: string;
  dueDate: string;
  paidAt: string | null;
  snapshot?: Record<string, unknown> | null;
  house?: { displayName: string; code?: string };
}

const route = useRoute();
const router = useRouter();
const { communities } = useCommunities();

const filter = ref({
  communityId: '',
  period: '',
  status: (route.query.status as string) || '',
  batchId: (route.query.batchId as string) || '',
  // 由「欠费与催缴 → 查账单」带入，直接定位到该住户
  houseId: (route.query.houseId as string) || '',
});
const bills = ref<Bill[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);

/**
 * 本页合计只算「待缴 + 已缴」。此前把已作废/已退款/未发布也加进来，
 * 收费员拿这个数对账必错。
 */
const COUNTED = ['UNPAID', 'PAID'];
const pageAmount = computed(() =>
  yuan(bills.value.filter((b) => COUNTED.includes(b.status)).reduce((s, b) => s + Number(b.amount || 0), 0)),
);

const STATUS_TEXT: Record<string, string> = {
  UNPAID: '待缴',
  PAID: '已缴',
  REFUNDED: '已退款',
  REFUNDING: '退款中',
  CANCELED: '已作废',
  DRAFT: '未发布',
};
function statusText(row: Bill): string {
  if (row.status === 'UNPAID' && isOverdue(row)) return '已逾期';
  return STATUS_TEXT[row.status] ?? row.status;
}
/**
 * 逾期按北京时间的「日」比较：到期日当天不算逾期。
 * 此前用 dueDate < Date.now()，而后端 dueDate 是当日 23:59:59 转 UTC，
 * 叠加 Math.max(1,…) 会让到期当天/次日凌晨就显示「已逾期 1 天」。
 */
function dueDay(row: Bill): Date | null {
  if (!row.dueDate) return null;
  const d = new Date(day(row.dueDate) + 'T00:00:00+08:00');
  return Number.isNaN(d.getTime()) ? null : d;
}
function isOverdue(row: Bill): boolean {
  if (row.status !== 'UNPAID') return false;
  const d = dueDay(row);
  return !!d && d.getTime() < shanghaiToday().getTime();
}
function overdueDays(row: Bill): number {
  const d = dueDay(row);
  if (!d) return 0;
  return Math.max(1, Math.round((shanghaiToday().getTime() - d.getTime()) / 86400000));
}

/** 金额可解释：业主质疑时一眼看出算式 */
function calcText(row: Bill): string {
  const s = row.snapshot ?? {};
  if (s.unitPrice != null && s.area != null) return `${s.area} ㎡ × ${s.unitPrice} 元/㎡`;
  if (s.amount != null) return `每户固定 ${s.amount} 元`;
  if (s.readingDiff != null) return `用量 ${s.readingDiff} × ${s.unitPrice} 元`;
  return '—';
}

/** 导出当前页账单，供核对与留档 */
function doExport() {
  exportCsv(`账单-${day(new Date())}`, bills.value, [
    { header: '房屋', value: (b) => b.house?.displayName ?? '' },
    { header: '费用', value: (b) => b.title },
    { header: '怎么算的', value: (b) => calcText(b) },
    { header: '金额(元)', value: (b) => yuan(b.amount) },
    { header: '状态', value: (b) => statusText(b) },
    { header: '到期日', value: (b) => day(b.dueDate) },
    { header: '缴费时间', value: (b) => (b.paidAt ? day(b.paidAt) : '') },
  ]);
  ElMessage.success(`已导出 ${bills.value.length} 条`);
}

function reload() {
  page.value = 1;
  void loadBills();
}

async function loadBills() {
  loading.value = true;
  try {
    const data = await api<Page<Bill>>(
      `/admin/bills${qs({ ...filter.value, page: page.value, pageSize: 20 })}`,
    );
    bills.value = data.list ?? [];
    total.value = data.total ?? 0;
  } finally {
    loading.value = false;
  }
}

/* ---------- 作废 / 重开 ---------- */
const reasonDialog = ref(false);
const reasonAction = ref<'cancel' | 'reissue'>('cancel');
const reasonText = ref('');
const reasonSubmitting = ref(false);
const currentBill = ref<Bill | null>(null);
/**
 * 幂等键在「打开对话框」时生成并持有整个提交过程。
 * 若每次点击都新生成，提交超时后重试会被后端当成一次全新操作——
 * 重开账单时就会复制出第二张同期待缴账单，业主两张都能付，造成真实重复收款。
 */
const reasonRequestId = ref('');

function openCancel(row: Bill) {
  currentBill.value = row;
  reasonAction.value = 'cancel';
  reasonText.value = '';
  reasonRequestId.value = genRequestId('bill-cancel');
  reasonDialog.value = true;
}
function openReissue(row: Bill) {
  currentBill.value = row;
  reasonAction.value = 'reissue';
  reasonText.value = '';
  reasonRequestId.value = genRequestId('bill-reissue');
  reasonDialog.value = true;
}

async function submitReason() {
  if (!currentBill.value) return;
  let body;
  try {
    body = buildReasonPayload(reasonText.value, reasonRequestId.value);
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

onMounted(loadBills);
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-4);
  margin-bottom: var(--sp-3);
  flex-wrap: wrap;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.field label {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}
.toolbar-right {
  margin-left: auto;
}
.summary {
  font-size: var(--fs-12);
  color: var(--text-secondary);
}
.summary b {
  color: var(--text-primary);
  font-weight: var(--fw-semibold);
}

.cell-main {
  font-size: var(--fs-13);
  font-weight: var(--fw-medium);
  color: var(--text-primary);
}
.cell-sub {
  font-size: var(--fs-12);
  color: var(--text-secondary);
  margin-top: 1px;
}
.cell-sub.overdue {
  color: var(--danger-text);
  font-weight: var(--fw-medium);
}
.calc {
  font-size: var(--fs-12);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.num {
  font-variant-numeric: tabular-nums;
}
.money {
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}

.empty {
  padding: var(--sp-8) 0;
  text-align: center;
  color: var(--text-tertiary);
}
.empty p {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-13);
}

.confirm-target {
  padding: var(--sp-3);
  background: var(--c-gray-50);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.confirm-line {
  display: flex;
  gap: var(--sp-3);
  font-size: var(--fs-13);
  padding: 2px 0;
}
.confirm-k {
  color: var(--text-tertiary);
  width: 40px;
  flex: 0 0 40px;
}
.confirm-v {
  color: var(--text-primary);
}
</style>
