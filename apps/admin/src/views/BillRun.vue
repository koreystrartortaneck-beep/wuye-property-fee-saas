<template>
  <!-- 顶部：这个账期现在到哪一步了 -->
  <div class="status-bar" :class="phaseClass">
    <div class="status-main">
      <span class="status-period">{{ periodLabel }}</span>
      <span class="status-text">{{ phaseText }}</span>
    </div>
    <div v-if="published" class="status-figures">
      <span><i>应收</i><b class="num">¥{{ publishedAmount }}</b></span>
      <span><i>户数</i><b class="num">{{ publishedCount }}</b></span>
    </div>
  </div>

  <!-- 第 1 步：收费标准 -->
  <section class="step" :class="{ done: rules.length > 0, active: rules.length === 0 }">
    <div class="step-head">
      <span class="step-no">1</span>
      <div>
        <h3 class="step-title">先设好收费标准</h3>
        <p class="step-desc">决定每户收多少钱。例如「住宅 2.5 元/㎡/月」，只需设置一次，以后每月沿用。</p>
      </div>
    </div>

    <div class="step-body">
      <div v-if="rules.length === 0" class="hollow">
        <p class="hollow-text">还没有收费标准，无法出账</p>
        <el-button type="primary" @click="openRuleDialog">设置收费标准</el-button>
      </div>
      <div v-else class="rule-list">
        <div v-for="r in rules" :key="r.id" class="rule-card">
          <div class="rule-name">{{ r.name }}</div>
          <div class="rule-meta">{{ houseTypeText(r.houseType) }} · {{ ruleAmountText(r) }}</div>
        </div>
        <button class="rule-add" @click="openRuleDialog">＋ 新增收费标准</button>
      </div>
    </div>
  </section>

  <!-- 第 2 步：账期与标准 -->
  <section class="step" :class="{ done: !!chosen.ruleId, active: rules.length > 0 && !chosen.ruleId }">
    <div class="step-head">
      <span class="step-no">2</span>
      <div>
        <h3 class="step-title">选择收哪个月、按哪个标准</h3>
        <p class="step-desc">账期就是这笔费用属于哪个月份。</p>
      </div>
    </div>
    <div class="step-body pick-row">
      <div class="field">
        <label>账期</label>
        <el-date-picker
          v-model="chosen.period"
          type="month"
          value-format="YYYY-MM"
          format="YYYY 年 M 月"
          :clearable="false"
          style="width: 160px"
          @change="onPeriodChange"
        />
      </div>
      <div class="field">
        <label>收费标准</label>
        <el-select v-model="chosen.ruleId" placeholder="请选择" style="width: 220px" :disabled="!rules.length">
          <el-option v-for="r in rules" :key="r.id" :label="`${r.name}（${ruleAmountText(r)}）`" :value="r.id" />
        </el-select>
      </div>
    </div>
  </section>

  <!-- 第 3 步：生成 -->
  <section class="step" :class="{ done: !!batch, active: !!chosen.ruleId && !batch }">
    <div class="step-head">
      <span class="step-no">3</span>
      <div>
        <h3 class="step-title">生成账单</h3>
        <p class="step-desc">系统按标准为每户算出金额。此时账单还<b>不会</b>给业主看到，可以放心生成。</p>
      </div>
    </div>
    <div class="step-body">
      <el-button
        type="primary"
        :loading="running"
        :disabled="!chosen.ruleId || !chosen.period"
        @click="generate"
      >{{ batch ? '重新生成（只补缺失的户）' : '生成账单' }}</el-button>

      <div v-if="lastRun" class="run-result">
        <p class="ok-line">✓ 本次生成 <b>{{ lastRun.generated }}</b> 户</p>
        <p v-if="lastRun.skipped > 0" class="warn-line">
          ⚠ 有 <b>{{ lastRun.skipped }}</b> 户没能生成：{{ skipText(lastRun) }}
          <span class="warn-tip">（请到「住户 → 房屋与业主」补齐这些房屋的信息后再重新生成）</span>
        </p>
      </div>
    </div>
  </section>

  <!-- 第 4 步：核对并发布 -->
  <section class="step" :class="{ done: published, active: !!batch && !published }">
    <div class="step-head">
      <span class="step-no">4</span>
      <div>
        <h3 class="step-title">核对金额，然后发布给业主</h3>
        <p class="step-desc">发布后业主就能在小程序看到这笔账单并缴费。发布前请先核对金额。</p>
      </div>
    </div>

    <div class="step-body">
      <div v-if="!batch" class="hollow small">
        <p class="hollow-text">还没有生成账单</p>
      </div>

      <template v-else>
        <div class="verify-bar">
          <div class="verify-figures">
            <span><i>共</i><b class="num">{{ batchCount }}</b><i>户</i></span>
            <span><i>合计</i><b class="num strong">¥{{ batchTotal }}</b></span>
          </div>
          <el-tag v-if="published" type="success" size="small">已发布 · 业主可见</el-tag>
          <el-tag v-else type="warning" size="small">未发布 · 业主看不到</el-tag>
        </div>

        <p v-if="listCapped" class="capped-note">
          下方仅显示前 {{ batchBills.length }} 户明细，合计金额与户数已按全部 {{ batchCount }} 户统计。
        </p>
        <el-table :data="batchBills" size="small" max-height="360" class="verify-table">
          <el-table-column label="房屋" min-width="160">
            <template #default="{ row }">{{ row.house?.displayName || '—' }}</template>
          </el-table-column>
          <el-table-column label="怎么算出来的" min-width="200">
            <template #default="{ row }">
              <span class="calc">{{ calcText(row) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="金额（元）" width="120" align="right">
            <template #default="{ row }"><span class="num strong">{{ yuan(row.amount) }}</span></template>
          </el-table-column>
          <el-table-column label="到期日" width="110">
            <template #default="{ row }">{{ day(row.dueDate) }}</template>
          </el-table-column>
        </el-table>

        <div v-if="!published" class="publish-row">
          <el-button type="primary" size="large" :loading="publishing" @click="publish">
            发布给业主（{{ batchCount }} 户 · ¥{{ batchTotal }}）
          </el-button>
          <span class="publish-note">发布后业主立即可在小程序缴费；发布不可撤销，请先核对金额。</span>
        </div>
        <div v-else class="published-row">
          ✓ 已发布，业主现在可以缴费了。可到「账单查询」查看缴费情况。
        </div>
      </template>
    </div>
  </section>

  <!-- 次要路径：从表格导入 -->
  <section class="step muted">
    <div class="step-head">
      <span class="step-no alt">或</span>
      <div>
        <h3 class="step-title">从表格导入账单</h3>
        <p class="step-desc">金额不按统一标准（如每户金额不同）时使用。上传后同样需要核对并发布。</p>
      </div>
    </div>
    <div class="step-body">
      <el-button text type="primary" @click="router.push('/bill-import')">去导入账单 →</el-button>
    </div>
  </section>

  <!-- 新建收费标准 -->
  <el-dialog v-model="ruleDialog" title="设置收费标准" width="480px">
    <el-form label-width="96px">
      <el-form-item label="名称">
        <el-input v-model="ruleForm.name" placeholder="如 住宅物业费" />
      </el-form-item>
      <el-form-item label="适用房屋">
        <el-select v-model="ruleForm.houseType" style="width: 100%">
          <el-option label="住宅" value="RESIDENCE" />
          <el-option label="商铺" value="SHOP" />
          <el-option label="车位" value="PARKING" />
          <el-option label="其他" value="OTHER" />
        </el-select>
      </el-form-item>
      <el-form-item label="怎么收">
        <el-radio-group v-model="ruleForm.mode">
          <el-radio value="AREA_PRICE">按面积（元/㎡/月）</el-radio>
          <el-radio value="FIXED">每户固定（元/月）</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="ruleForm.mode === 'AREA_PRICE' ? '单价' : '金额'">
        <el-input-number v-model="ruleForm.value" :min="0.01" :precision="2" :step="0.5" style="width: 160px" />
        <span class="unit">{{ ruleForm.mode === 'AREA_PRICE' ? '元/㎡/月' : '元/月' }}</span>
      </el-form-item>
      <el-form-item label="缴费期限">
        <el-input-number v-model="ruleForm.dueDays" :min="1" :max="365" style="width: 120px" />
        <span class="unit">天内缴清</span>
      </el-form-item>
      <el-alert
        v-if="ruleForm.mode === 'AREA_PRICE'"
        type="info"
        :closable="false"
        show-icon
        :title="`例：89 ㎡ 的房子每月 ${(89 * (ruleForm.value || 0)).toFixed(2)} 元`"
      />
    </el-form>
    <template #footer>
      <el-button @click="ruleDialog = false">取消</el-button>
      <el-button type="primary" :loading="savingRule" @click="saveRule">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';
import { currentMonth, useCommunities } from '../composables';
import { day, genRequestId, yuan } from '../finance';

interface Rule {
  id: string;
  name: string;
  houseType: string;
  ruleType: string;
  params: Record<string, unknown>;
  communityId: string;
}
interface Run {
  generated: number;
  skipped: number;
  skippedDetail?: { code: string; reason: string }[] | null;
}
interface Batch {
  id: string;
  batchNo: string;
  period: string;
  status: string;
  /** 权威合计与户数：不能用已加载的行去求和，超过一页会算少 */
  totalAmount: string;
  validRows: number;
}
interface Bill {
  id: string;
  amount: string;
  dueDate: string;
  status: string;
  snapshot?: Record<string, unknown> | null;
  house?: { displayName: string };
}

const router = useRouter();
const { communities } = useCommunities();
const rules = ref<Rule[]>([]);
const chosen = ref({ period: currentMonth(), ruleId: '' });
const running = ref(false);
const publishing = ref(false);
const lastRun = ref<Run | null>(null);
const batch = ref<Batch | null>(null);
const batchBills = ref<Bill[]>([]);

const published = computed(() => batch.value?.status === 'PUBLISHED');
const periodLabel = computed(() => {
  const [y, m] = chosen.value.period.split('-');
  return `${y} 年 ${Number(m)} 月`;
});
/** 合计与户数一律取后端权威值，避免只加载一页时算少 */
const batchTotal = computed(() => yuan(batch.value?.totalAmount ?? 0));
const batchCount = computed(() => batch.value?.validRows ?? batchBills.value.length);
/** 明细表最多展示一页，超出时明确告知，不让用户误以为只有这些 */
const listCapped = computed(() => batchCount.value > batchBills.value.length);
const publishedAmount = computed(() => batchTotal.value);
const publishedCount = computed(() => batchCount.value);

const phaseText = computed(() => {
  if (!rules.value.length) return '还没有收费标准，先在下面第 1 步设置';
  if (!batch.value) return '尚未生成账单';
  if (!published.value) return '已生成但未发布，业主还看不到';
  return '已发布，业主可以缴费';
});
const phaseClass = computed(() => {
  if (!rules.value.length || !batch.value) return 'is-todo';
  return published.value ? 'is-done' : 'is-pending';
});

const HOUSE_TYPE: Record<string, string> = {
  RESIDENCE: '住宅',
  SHOP: '商铺',
  PARKING: '车位',
  OTHER: '其他',
};
function houseTypeText(t: string): string {
  return HOUSE_TYPE[t] ?? t;
}
function ruleAmountText(r: Rule): string {
  if (r.ruleType === 'AREA_PRICE') return `${r.params?.unitPrice ?? '?'} 元/㎡/月`;
  if (r.ruleType === 'FIXED') return `${r.params?.amount ?? '?'} 元/月`;
  if (r.ruleType === 'METER') return `按抄表 ${r.params?.unitPrice ?? '?'} 元/单位`;
  if (r.ruleType === 'SHARE') return '公共费用分摊';
  return '自定义公式';
}

/** 让每个金额都能解释清楚，业主质疑时一秒答得上来 */
function calcText(row: Bill): string {
  const s = row.snapshot ?? {};
  if (s.unitPrice != null && s.area != null) return `${s.area} ㎡ × ${s.unitPrice} 元/㎡`;
  if (s.amount != null) return `每户固定 ${s.amount} 元`;
  if (s.readingDiff != null) return `用量 ${s.readingDiff} × ${s.unitPrice} 元`;
  return '—';
}

const SKIP_REASON: Record<string, string> = {
  AREA_MISSING: '房屋没填面积',
  METER_READING_MISSING: '本期没有抄表读数',
  SHARE_POOL_MISSING: '没录入公共费用总额',
  FORMULA_INVALID: '公式算不出结果',
};
function skipText(run: Run): string {
  const detail = run.skippedDetail ?? [];
  if (!detail.length) return '原因未知';
  return detail
    .map((d) => `${d.code === '*' ? '全部房屋' : d.code}（${SKIP_REASON[d.reason] ?? d.reason}）`)
    .join('；');
}

async function loadRules() {
  const data = await api<Page<Rule>>(`/admin/fee-rules${qs({ pageSize: 200 })}`);
  rules.value = data.list ?? [];
  if (!chosen.value.ruleId && rules.value.length === 1) chosen.value.ruleId = rules.value[0].id;
}

/** 找出该账期已存在的批次，让用户能接着上次继续，而不是重复生成 */
async function loadBatchForPeriod() {
  batch.value = null;
  batchBills.value = [];
  lastRun.value = null;
  try {
    const data = await api<Page<Batch>>(`/admin/bill-batches${qs({ pageSize: 200 })}`);
    const hit = (data.list ?? [])
      .filter((b) => b.period === chosen.value.period && b.status !== 'CANCELED')
      .sort((a, b) => (a.status === 'DRAFT' ? -1 : 1))[0];
    if (hit) {
      batch.value = hit;
      await loadBatchBills(hit.id);
    }
  } catch {
    /* 静默：不影响生成流程 */
  }
}

async function loadBatchBills(batchId: string) {
  const data = await api<Page<Bill>>(`/admin/bills${qs({ batchId, pageSize: 200 })}`);
  batchBills.value = (data.list ?? []).filter((b) => b.status !== 'CANCELED');
}

function onPeriodChange() {
  void loadBatchForPeriod();
}

async function generate() {
  running.value = true;
  try {
    const res = await api<{ batchId: string; generated: number; skipped: number; skippedDetail?: Run['skippedDetail'] }>(
      '/admin/bill-runs',
      { method: 'POST', body: { ruleId: chosen.value.ruleId, period: chosen.value.period } },
    );
    lastRun.value = { generated: res.generated, skipped: res.skipped, skippedDetail: res.skippedDetail ?? null };
    await loadBatchForPeriod();
    ElMessage.success(`已生成 ${res.generated} 户账单，请核对后发布`);
  } finally {
    running.value = false;
  }
}

async function publish() {
  if (!batch.value) return;
  publishing.value = true;
  try {
    await api(`/admin/bill-batches/${batch.value.id}/publish`, {
      method: 'POST',
      body: { requestId: genRequestId('publish') },
    });
    ElMessage.success('已发布，业主现在可以缴费');
    await loadBatchForPeriod();
  } finally {
    publishing.value = false;
  }
}

/* ---------- 新建收费标准 ---------- */
const ruleDialog = ref(false);
const savingRule = ref(false);
const ruleForm = ref({
  name: '住宅物业费',
  houseType: 'RESIDENCE',
  mode: 'AREA_PRICE' as 'AREA_PRICE' | 'FIXED',
  value: 2.5,
  dueDays: 30,
});

function openRuleDialog() {
  ruleForm.value = { name: '住宅物业费', houseType: 'RESIDENCE', mode: 'AREA_PRICE', value: 2.5, dueDays: 30 };
  ruleDialog.value = true;
}

async function saveRule() {
  const communityId = communities.value[0]?.id;
  if (!communityId) return ElMessage.warning('请先在「设置 → 小区信息」创建小区');
  if (!ruleForm.value.name.trim()) return ElMessage.warning('请填写名称');
  if (!ruleForm.value.value || ruleForm.value.value <= 0) return ElMessage.warning('金额必须大于 0');
  savingRule.value = true;
  try {
    await api('/admin/fee-rules', {
      method: 'POST',
      body: {
        communityId,
        name: ruleForm.value.name.trim(),
        houseType: ruleForm.value.houseType,
        ruleType: ruleForm.value.mode,
        params:
          ruleForm.value.mode === 'AREA_PRICE'
            ? { unitPrice: ruleForm.value.value }
            : { amount: ruleForm.value.value },
        period: 'MONTHLY',
        billDay: 1,
        dueDays: ruleForm.value.dueDays,
      },
    });
    ElMessage.success('收费标准已保存');
    ruleDialog.value = false;
    await loadRules();
  } finally {
    savingRule.value = false;
  }
}

onMounted(async () => {
  await loadRules();
  await loadBatchForPeriod();
});
</script>

<style scoped>
/* ---------- 顶部状态条 ---------- */
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
  margin-bottom: var(--sp-4);
  flex-wrap: wrap;
}
.status-bar.is-todo {
  border-left: 3px solid var(--warning);
}
.status-bar.is-pending {
  border-left: 3px solid var(--primary);
}
.status-bar.is-done {
  border-left: 3px solid var(--success);
}
.status-main {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.status-period {
  font-size: var(--fs-17);
  font-weight: var(--fw-semibold);
}
.status-text {
  font-size: var(--fs-12);
  color: var(--text-secondary);
}
.status-figures {
  display: flex;
  gap: var(--sp-6);
}
.status-figures span {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.status-figures i {
  font-style: normal;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}
.status-figures b {
  font-size: var(--fs-17);
  font-weight: var(--fw-semibold);
}

/* ---------- 步骤 ---------- */
.step {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-sm);
  margin-bottom: var(--sp-3);
  padding: var(--sp-4);
  transition: box-shadow var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.step.active {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft), var(--shadow-sm);
}
.step.muted {
  background: transparent;
  box-shadow: none;
  border-style: dashed;
}
.step-head {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
}
.step-no {
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  border-radius: var(--r-full);
  background: var(--c-gray-200);
  color: var(--text-secondary);
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
  display: flex;
  align-items: center;
  justify-content: center;
}
.step.active .step-no {
  background: var(--primary);
  color: var(--text-inverse);
}
.step.done .step-no {
  background: var(--success-soft);
  color: var(--success-text);
}
.step-no.alt {
  font-size: var(--fs-11);
}
.step-title {
  margin: 0;
  font-size: var(--fs-15);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}
.step-desc {
  margin: 2px 0 0;
  font-size: var(--fs-12);
  color: var(--text-secondary);
  line-height: var(--lh-normal);
}
.step-body {
  padding-left: 36px;
  margin-top: var(--sp-3);
}

/* ---------- 空态 ---------- */
.hollow {
  padding: var(--sp-6);
  text-align: center;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-md);
  background: var(--c-gray-50);
}
.hollow.small {
  padding: var(--sp-4);
}
.hollow-text {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-13);
  color: var(--text-secondary);
}
.hollow.small .hollow-text {
  margin: 0;
}

/* ---------- 收费标准卡 ---------- */
.rule-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.rule-card {
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--c-gray-50);
  min-width: 180px;
}
.rule-name {
  font-size: var(--fs-13);
  font-weight: var(--fw-medium);
}
.rule-meta {
  font-size: var(--fs-12);
  color: var(--text-secondary);
  margin-top: 2px;
}
.rule-add {
  padding: var(--sp-2) var(--sp-3);
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--primary);
  font-size: var(--fs-12);
  cursor: pointer;
}
.rule-add:hover {
  background: var(--primary-soft);
}

/* ---------- 选择行 ---------- */
.pick-row {
  display: flex;
  gap: var(--sp-6);
  flex-wrap: wrap;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field label {
  font-size: var(--fs-12);
  color: var(--text-secondary);
}

/* ---------- 生成结果 ---------- */
.run-result {
  margin-top: var(--sp-3);
}
.ok-line,
.warn-line {
  margin: 0 0 4px;
  font-size: var(--fs-13);
}
.ok-line {
  color: var(--success-text);
}
.warn-line {
  color: var(--warning-text);
}
.warn-tip {
  color: var(--text-secondary);
  font-size: var(--fs-12);
}

/* ---------- 核对 ---------- */
.verify-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  margin-bottom: var(--sp-3);
  flex-wrap: wrap;
}
.verify-figures {
  display: flex;
  gap: var(--sp-6);
}
.verify-figures span {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.verify-figures i {
  font-style: normal;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}
.verify-figures b {
  font-size: var(--fs-15);
  font-weight: var(--fw-semibold);
}
.verify-figures b.strong {
  font-size: var(--fs-20);
}
.capped-note {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-12);
  color: var(--warning-text);
}
.verify-table {
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.calc {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.num {
  font-variant-numeric: tabular-nums;
}
.strong {
  font-weight: var(--fw-semibold);
}

.publish-row {
  margin-top: var(--sp-4);
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.publish-note {
  font-size: var(--fs-12);
  color: var(--text-secondary);
}
.published-row {
  margin-top: var(--sp-3);
  font-size: var(--fs-13);
  color: var(--success-text);
}
.unit {
  margin-left: var(--sp-2);
  font-size: var(--fs-12);
  color: var(--text-secondary);
}

@media (max-width: 900px) {
  .step-body {
    padding-left: 0;
  }
}
</style>
