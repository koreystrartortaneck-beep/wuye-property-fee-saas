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

  <!-- 同一账期可能按多个收费标准分成多批，漏发会导致部分业主收不到账单 -->
  <el-alert
    v-if="otherPending > 0"
    type="warning"
    :closable="false"
    show-icon
    class="pending-alert"
    :title="`本账期还有 ${otherPending} 批账单未发布（按其它收费标准生成）`"
  >
    在上方第 2 步切换到对应的收费标准，即可核对并发布那一批。否则这部分业主收不到账单。
  </el-alert>

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
        <button
          v-for="r in rules"
          :key="r.id"
          class="rule-card"
          :class="{ picked: chosen.ruleId === r.id }"
          @click="chosen.ruleId = r.id"
        >
          <div class="rule-name">
            {{ r.name }}
            <span v-if="chosen.ruleId === r.id" class="rule-pick-tag">本次使用</span>
          </div>
          <div class="rule-meta">{{ houseTypeText(r.houseType) }} · {{ ruleAmountText(r) }}</div>
          <div class="rule-usage" :class="{ unused: ruleUsage(r.id) === 0 }">
            {{ ruleUsage(r.id) === 0 ? '还没用它出过账单' : `已出账 ${ruleUsage(r.id)} 次` }}
          </div>
        </button>
        <button class="rule-add" @click="openRuleDialog">＋ 新增收费标准</button>
      </div>
      <p class="rule-tip">
        新建的收费标准不会自动产生费用，需要在下面第 2、3 步选中它并生成账单，业主才会看到。
      </p>
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
          :disabled-date="disableFarFuture"
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
      >{{ published ? '本账期已发布' : batch ? '重新生成（只补缺失的户）' : '生成账单' }}</el-button>

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
                  <template #empty>
            <EmptyState icon="⚠️" title="这一批没有生成任何账单" desc="通常是所选收费标准没有匹配到房屋（如面积缺失或房屋类型不符），请回上一步检查" />
          </template>
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
  <el-dialog v-model="ruleDialog" title="设置收费标准" width="min(480px, 92vw)">
    <el-form label-width="96px">
      <!--
        小区必须显式选择。原先 saveRule 里写死 communities.value[0]?.id，
        多小区的物业公司会把规则建到列表里第一个小区上，而界面上没有任何地方
        显示这条规则属于哪个小区——出账时才会发现选不到它。
        单小区时不显示这一项，避免多一次无意义的点击。
      -->
      <el-form-item v-if="communities.length > 1" label="所属小区">
        <el-select v-model="ruleForm.communityId" placeholder="请选择小区" style="width: 100%">
          <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="名称">
        <el-input v-model="ruleForm.name" placeholder="自己起名，如 住宅物业费 / 车位管理费" />
      </el-form-item>
      <el-form-item label="适用房屋">
        <el-select v-model="ruleForm.houseType" style="width: 100%">
          <el-option label="住宅" value="RESIDENCE" />
          <el-option label="商铺" value="SHOP" />
          <el-option label="车位" value="PARKING" />
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
        <el-input-number v-model="ruleForm.dueDays" :min="1" :max="90" style="width: 120px" />
        <span class="unit">天内缴清（最多 90 天）</span>
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
import EmptyState from '../components/EmptyState.vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
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
// 账期可由「导入账单」跳转带入：否则导 6 月账单却落地 7 月，
// 显示「尚未生成账单」，用户以为导入失败。
const route = useRoute();
const initialPeriod = (route.query.period as string) || '';
const chosen = ref({
  period: /^\d{4}-\d{2}$/.test(initialPeriod) ? initialPeriod : currentMonth(),
  ruleId: '',
});
const running = ref(false);
const publishing = ref(false);
/** 同一批次的发布重试复用同一幂等键，避免超时重试被当成新一次发布 */
const publishRequestId = ref('');
/** 同账期其它尚未发布的批次数量（如车位费与住宅费分属两批） */
const otherPending = ref(0);
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

/** 每个收费标准被用来出过几次账：让"建完了但没用"一眼可见 */
const runCountByRule = ref<Record<string, number>>({});
function ruleUsage(ruleId: string): number {
  return runCountByRule.value[ruleId] ?? 0;
}
async function loadRunStats() {
  try {
    const data = await api<Page<{ ruleId: string }>>(`/admin/bill-runs${qs({ pageSize: 200 })}`);
    const map: Record<string, number> = {};
    for (const r of data.list ?? []) map[r.ruleId] = (map[r.ruleId] ?? 0) + 1;
    runCountByRule.value = map;
  } catch {
    runCountByRule.value = {};
  }
}

async function loadRules() {
  const data = await api<Page<Rule>>(`/admin/fee-rules${qs({ pageSize: 200 })}`);
  rules.value = data.list ?? [];
  if (!chosen.value.ruleId && rules.value.length === 1) chosen.value.ruleId = rules.value[0].id;
}

/** 找出该账期已存在的批次，让用户能接着上次继续，而不是重复生成 */
/**
 * 按「账期 + 当前所选收费标准」精确定位批次。
 * 此前只按账期取第一个，若同一账期先出住宅费再出车位费（后端 batchNo 为
 * RULE-<period>-<ruleId>，是两个批次），核对区会显示错的那一批，
 * 发布也只发这一批 —— 另一批的业主永远收不到账单，页面却显示「已发布」。
 */
async function loadBatchForPeriod() {
  batch.value = null;
  batchBills.value = [];
  lastRun.value = null;
  publishRequestId.value = '';
  otherPending.value = 0;
  try {
    const data = await api<Page<Batch>>(`/admin/bill-batches${qs({ period: chosen.value.period, pageSize: 200 })}`);
    const inPeriod = (data.list ?? []).filter(
      (b) => b.period === chosen.value.period && b.status !== 'CANCELED',
    );
    const wanted = chosen.value.ruleId ? `RULE-${chosen.value.period}-${chosen.value.ruleId}` : '';
    const hit = wanted ? inPeriod.find((b) => b.batchNo === wanted) : undefined;
    if (hit) {
      batch.value = hit;
      await loadBatchBills(hit.id);
    }
    // 同账期还有别的未发布批次时明确提示，避免漏发
    otherPending.value = inPeriod.filter(
      (b) => b.id !== hit?.id && b.status !== 'PUBLISHED',
    ).length;
  } catch {
    /* 静默：不影响生成流程 */
  }
}

async function loadBatchBills(batchId: string) {
  const data = await api<Page<Bill>>(`/admin/bills${qs({ batchId, pageSize: 200 })}`);
  batchBills.value = (data.list ?? []).filter((b) => b.status !== 'CANCELED');
}

/** 账期最多允许提前一个月，避免误给 2030 年出账 */
function disableFarFuture(d: Date): boolean {
  const limit = new Date();
  limit.setMonth(limit.getMonth() + 1);
  return d.getTime() > limit.getTime();
}

function onPeriodChange() {
  void loadBatchForPeriod();
}

// 换收费标准同样要重载：否则核对的是另一标准生成的账单
watch(() => chosen.value.ruleId, () => void loadBatchForPeriod());

async function generate() {
  running.value = true;
  try {
    const res = await api<{
      batchId: string;
      generated: number;
      skipped: number;
      skippedDetail?: Run['skippedDetail'];
      alreadyPublished?: boolean;
    }>('/admin/bill-runs', {
      method: 'POST',
      body: { ruleId: chosen.value.ruleId, period: chosen.value.period },
    });
    await Promise.all([loadBatchForPeriod(), loadRunStats()]);
    if (res.alreadyPublished) {
      // 后端对已发布批次直接早返回 generated:0，此前前端仍报喜「已生成 0 户」，
      // 用户以为补账成功，实际新增房屋永远收不到账单。
      lastRun.value = null;
      ElMessageBox.alert(
        '本账期的账单已经发布，无法再往这一批里追加。\n' +
          '如需为新增房屋补账，请用「导入账单」单独出一批，或改用下一个账期。',
        '已发布，无法追加',
        { confirmButtonText: '知道了', type: 'warning' },
      );
      return;
    }
    lastRun.value = { generated: res.generated, skipped: res.skipped, skippedDetail: res.skippedDetail ?? null };
    ElMessage.success(`已生成 ${res.generated} 户账单，请核对后发布`);
  } finally {
    running.value = false;
  }
}

async function publish() {
  if (!batch.value) return;
  // 发布不可撤销，且立刻对全体业主生效——这是本页唯一真正不可逆的动作
  try {
    await ElMessageBox.confirm(
      `即将向 ${batchCount.value} 户发布账单，合计 ¥${batchTotal.value}。\n` +
        '发布后业主立即可在小程序看到并缴费，且无法撤销。请确认金额无误。',
      '确认发布给业主',
      { type: 'warning', confirmButtonText: '确认发布', cancelButtonText: '再核对一下' },
    );
  } catch {
    return;
  }
  if (!publishRequestId.value) publishRequestId.value = genRequestId(`publish-${batch.value.id}`);
  publishing.value = true;
  try {
    await api(`/admin/bill-batches/${batch.value.id}/publish`, {
      method: 'POST',
      body: { requestId: publishRequestId.value },
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
  communityId: '',
  name: '',
  houseType: 'RESIDENCE',
  mode: 'AREA_PRICE' as 'AREA_PRICE' | 'FIXED',
  value: 2.5,
  dueDays: 30,
});

function openRuleDialog() {
  ruleForm.value = {
    // 单小区时自动填上；多小区时留空，强制选择
    communityId: communities.value.length === 1 ? communities.value[0].id : '',
    name: '',
    houseType: 'RESIDENCE',
    mode: 'AREA_PRICE',
    value: 2.5,
    dueDays: 30,
  };
  ruleDialog.value = true;
}

async function saveRule() {
  if (communities.value.length === 0) {
    return ElMessage.warning('请先在「设置 → 小区信息」创建小区');
  }
  const communityId = ruleForm.value.communityId;
  if (!communityId) return ElMessage.warning('请选择这条收费标准所属的小区');
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
    ElMessage.success({
      message: '收费标准已保存。接着在第 2 步选中它、第 3 步生成账单，业主才会看到费用。',
      duration: 5000,
    });
    ruleDialog.value = false;
    const before = new Set(rules.value.map((r) => r.id));
    await loadRules();
    // 自动选中刚建的那个，省去用户再找一次
    const fresh = rules.value.find((r) => !before.has(r.id));
    if (fresh) chosen.value.ruleId = fresh.id;
  } finally {
    savingRule.value = false;
  }
}

onMounted(async () => {
  await loadRules();
  await Promise.all([loadBatchForPeriod(), loadRunStats()]);
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
.pending-alert {
  margin-bottom: var(--sp-3);
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
.rule-card {
  cursor: pointer;
  text-align: left;
  transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}
.rule-card:hover {
  border-color: var(--border-strong);
}
.rule-card.picked {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
  background: var(--bg-card);
}
.rule-pick-tag {
  margin-left: 6px;
  font-size: var(--fs-11);
  font-weight: var(--fw-regular);
  color: var(--primary);
}
.rule-usage {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  margin-top: 3px;
}
.rule-usage.unused {
  color: var(--warning-text);
}
.rule-tip {
  margin: var(--sp-3) 0 0;
  font-size: var(--fs-12);
  color: var(--text-secondary);
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
