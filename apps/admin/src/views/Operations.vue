<template>
  <div v-loading="loading">
    <!-- 总体结论：这套系统现在能不能安心收钱 -->
    <div v-if="metrics" class="verdict" :class="metrics.overallPass ? 'ok' : 'bad'">
      <div>
        <h2 class="v-title">{{ metrics.overallPass ? '各项指标均达标' : '有指标未达标，需要关注' }}</h2>
        <p class="v-desc">
          统计窗口：最近 {{ metrics.windowDays }} 天 · 生成于 {{ dt(metrics.generatedAt) }}
        </p>
      </div>
      <el-button :loading="loading" @click="load">重新检查</el-button>
    </div>

    <!-- 配置就绪度：没配告警等于出事没人知道 -->
    <el-card v-if="readiness" class="block">
      <template #header>
        配置就绪度
        <el-tag :type="readiness.healthy ? 'success' : 'warning'" size="small" effect="light" class="hd-tag">
          {{ readiness.healthy ? '就绪' : '有待配置' }}
        </el-tag>
      </template>
      <div v-for="c in readiness.checks" :key="c.name" class="check">
        <span class="ck-icon" :class="c.healthy ? 'ok' : 'bad'">{{ c.healthy ? '✓' : '!' }}</span>
        <div>
          <div class="ck-name">{{ CHECK_LABEL[c.name] || c.name }}</div>
          <div class="ck-detail">{{ c.detail }}</div>
          <div v-if="!c.healthy && c.name === 'ALERT_DESTINATION'" class="ck-hint">
            在云托管环境变量中设置 OPS_ALERT_WEBHOOK（企业微信/钉钉机器人地址），
            回调失败、对账差异等异常才会主动推送给你。
          </div>
        </div>
      </div>
    </el-card>

    <!-- 六项灰度指标 -->
    <el-card v-if="metrics" class="block">
      <template #header>关键指标（近 {{ metrics.windowDays }} 天）</template>
      <div class="metrics">
        <div v-for="m in metricCards" :key="m.key" class="metric" :class="{ bad: !m.pass }">
          <div class="m-head">
            <span class="m-name">{{ m.name }}</span>
            <el-tag :type="m.pass ? 'success' : 'danger'" size="small" effect="light">
              {{ m.pass ? '达标' : '未达标' }}
            </el-tag>
          </div>
          <div class="m-value num">{{ m.display }}</div>
          <div class="m-desc">{{ m.desc }}</div>
        </div>
      </div>
    </el-card>

    <!-- 每日支付成功率 -->
    <el-card v-if="metrics && metrics.daily.length" class="block">
      <template #header>每日支付成功率</template>
      <div class="bars">
        <div v-for="d in metrics.daily" :key="d.day" class="bar-col">
          <div class="bar-track">
            <div
              class="bar-fill"
              :class="{ warn: d.rate < 0.98 && d.total > 0 }"
              :style="{ height: `${Math.round(d.rate * 100)}%` }"
            />
          </div>
          <span class="bar-day">{{ String(d.day).slice(5) }}</span>
          <span class="bar-tip">{{ d.total > 0 ? `${d.success}/${d.total}` : '—' }}</span>
        </div>
      </div>
    </el-card>

    <!-- 运营事件处置 -->
    <el-card class="block">
      <template #header>
        运营事件
        <el-select v-model="incidentStatus" size="small" class="hd-select" @change="loadIncidents">
          <el-option label="待处理" value="OPEN" />
          <el-option label="已确认" value="ACKNOWLEDGED" />
          <el-option label="已解决" value="RESOLVED" />
          <el-option label="全部" :value="undefined" />
        </el-select>
      </template>

      <el-table :data="incidents" size="small">
        <el-table-column label="事件" min-width="240">
          <template #default="{ row }">
            <div class="cell-main">{{ row.title }}</div>
            <div class="cell-sub">
              首次 {{ dt(row.openedAt) }}
              <template v-if="row.occurrences > 1"> · 累计 {{ row.occurrences }} 次</template>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="级别" width="100">
          <template #default="{ row }">
            <el-tag :type="row.severity === 'CRITICAL' ? 'danger' : 'warning'" size="small" effect="light">
              {{ SEVERITY_LABEL[row.severity] || row.severity }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="incidentTag(row.status)" size="small" effect="light">
              {{ INCIDENT_STATUS_LABEL[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="处置说明" min-width="160">
          <template #default="{ row }"><span class="cell-sub">{{ row.reason || '—' }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'OPEN'"
              size="small"
              :loading="acting === row.id"
              @click="transition(row, 'acknowledge')"
            >确认接手</el-button>
            <el-button
              v-if="row.status !== 'RESOLVED'"
              size="small"
              type="success"
              :loading="acting === row.id"
              @click="transition(row, 'resolve')"
            >标记解决</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="tbl-empty">
            <p class="te-title">没有{{ incidentStatus === 'OPEN' ? '待处理的' : '' }}运营事件</p>
            <p class="te-desc">支付回调失败、对账差异、定时任务异常等会自动在此登记</p>
          </div>
        </template>
      </el-table>
      <el-pagination
        layout="total, prev, pager, next"
        :total="incidentTotal"
        :page-size="20"
        :current-page="incidentPage"
        @current-change="(p: number) => { incidentPage = p; loadIncidents(); }"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, qs, type Page } from '../api';
import { dt } from '../finance';

interface Gate {
  value: number | boolean;
  threshold?: number;
  pass: boolean;
  prepayUnknown?: number;
  abnormalRefunds?: number;
}
interface Metrics {
  windowDays: number;
  generatedAt: string;
  paymentTechnicalSuccessRate: Gate;
  duplicateChargeCount: Gate;
  unresolvedReconciliationDifferences: Gate;
  refundCompletionRate: Gate;
  severeIncidentCount: Gate;
  moneyLossIndicator: Gate;
  overallPass: boolean;
  daily: { day: string; success: number; total: number; rate: number }[];
}
interface Readiness {
  healthy: boolean;
  checks: { name: string; healthy: boolean; detail: string }[];
}
interface Incident {
  id: string;
  title: string;
  severity: string;
  status: string;
  occurrences: number;
  openedAt: string;
  reason: string | null;
}

const CHECK_LABEL: Record<string, string> = { ALERT_DESTINATION: '异常告警推送地址' };
const SEVERITY_LABEL: Record<string, string> = { INFO: '提示', WARNING: '警告', CRITICAL: '严重' };
const INCIDENT_STATUS_LABEL: Record<string, string> = {
  OPEN: '待处理',
  ACKNOWLEDGED: '已确认',
  RESOLVED: '已解决',
};

const metrics = ref<Metrics | null>(null);
const readiness = ref<Readiness | null>(null);
const incidents = ref<Incident[]>([]);
const incidentTotal = ref(0);
const incidentPage = ref(1);
const incidentStatus = ref<string | undefined>('OPEN');
const loading = ref(false);
const acting = ref('');

function pct(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

/** 把后端的门禁指标翻译成收费员也能看懂的话 */
const metricCards = computed(() => {
  const m = metrics.value;
  if (!m) return [];
  return [
    {
      key: 'pay',
      name: '支付技术成功率',
      display: pct(m.paymentTechnicalSuccessRate.value),
      pass: m.paymentTechnicalSuccessRate.pass,
      desc:
        `门槛 ${pct(m.paymentTechnicalSuccessRate.threshold)}` +
        (m.paymentTechnicalSuccessRate.prepayUnknown
          ? ` · 另有 ${m.paymentTechnicalSuccessRate.prepayUnknown} 笔结果待确认`
          : ''),
    },
    {
      key: 'dup',
      name: '重复收款',
      display: String(m.duplicateChargeCount.value),
      pass: m.duplicateChargeCount.pass,
      desc: '同一账单被收多次的笔数，必须为 0',
    },
    {
      key: 'recon',
      name: '未处置对账差异',
      display: String(m.unresolvedReconciliationDifferences.value),
      pass: m.unresolvedReconciliationDifferences.pass,
      desc: '与微信支付核对不上且未处理的条目',
    },
    {
      key: 'refund',
      name: '退款完成率',
      display: pct(m.refundCompletionRate.value),
      pass: m.refundCompletionRate.pass,
      desc: `门槛 ${pct(m.refundCompletionRate.threshold)}`,
    },
    {
      key: 'incident',
      name: '严重事件',
      display: String(m.severeIncidentCount.value),
      pass: m.severeIncidentCount.pass,
      desc: '近期发生的严重级运营事件数',
    },
    {
      key: 'loss',
      name: '资金异常',
      display: m.moneyLossIndicator.value ? '存在' : '无',
      pass: m.moneyLossIndicator.pass,
      desc: m.moneyLossIndicator.abnormalRefunds
        ? `含 ${m.moneyLossIndicator.abnormalRefunds} 笔异常退款`
        : '重复收款、对账差异、异常退款的综合判定',
    },
  ];
});

function incidentTag(s: string): 'success' | 'warning' | 'danger' | 'info' {
  if (s === 'RESOLVED') return 'success';
  if (s === 'ACKNOWLEDGED') return 'warning';
  if (s === 'OPEN') return 'danger';
  return 'info';
}

async function loadIncidents() {
  const res = await api<Page<Incident>>(
    `/admin/operations/incidents${qs({ status: incidentStatus.value, page: incidentPage.value, pageSize: 20 })}`,
  );
  incidents.value = res.list ?? [];
  incidentTotal.value = res.total ?? 0;
}

async function transition(row: Incident, action: 'acknowledge' | 'resolve') {
  let reason = '';
  if (action === 'resolve') {
    try {
      const r = await ElMessageBox.prompt('请说明处置结果（记入操作留痕）', '标记解决', {
        confirmButtonText: '标记解决',
        cancelButtonText: '取消',
        inputPlaceholder: '如：已修复回调配置并复验通过',
        inputValidator: (v) => (v && v.trim() ? true : '请填写处置说明'),
      });
      reason = r.value.trim();
    } catch {
      return;
    }
  }
  acting.value = row.id;
  try {
    await api(`/admin/operations/incidents/${row.id}/${action}`, {
      method: 'POST',
      body: { reason: reason || undefined },
    });
    ElMessage.success(action === 'acknowledge' ? '已确认接手' : '已标记解决');
    await Promise.all([loadIncidents(), load()]);
  } finally {
    acting.value = '';
  }
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const [m, r] = await Promise.all([
      api<Metrics>('/admin/operations/metrics'),
      api<Readiness>('/admin/operations/readiness'),
    ]);
    metrics.value = m;
    readiness.value = r;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await Promise.all([load(), loadIncidents()]);
});
</script>

<style scoped>
.verdict {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-4);
  border-radius: var(--r-md);
  background: var(--bg-card);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  flex-wrap: wrap;
}
.verdict.ok {
  border-left: 3px solid var(--success);
}
.verdict.bad {
  border-left: 3px solid var(--danger);
}
.v-title {
  margin: 0;
  font-size: var(--fs-17);
  font-weight: var(--fw-semibold);
}
.v-desc {
  margin: 2px 0 0;
  font-size: var(--fs-12);
  color: var(--text-secondary);
}

.block {
  margin-top: var(--sp-3);
}
.hd-tag,
.hd-select {
  float: right;
}
.hd-select {
  width: 120px;
}

.check {
  display: flex;
  gap: var(--sp-3);
  padding: var(--sp-2) 0;
}
.ck-icon {
  flex: 0 0 20px;
  width: 20px;
  height: 20px;
  border-radius: var(--r-full);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-12);
  font-weight: var(--fw-bold);
  color: var(--text-inverse);
}
.ck-icon.ok {
  background: var(--success);
}
.ck-icon.bad {
  background: var(--warning);
}
.ck-name {
  font-size: var(--fs-13);
  font-weight: var(--fw-medium);
}
.ck-detail {
  font-size: var(--fs-12);
  color: var(--text-secondary);
}
.ck-hint {
  margin-top: var(--sp-1);
  font-size: var(--fs-12);
  color: var(--warning-text);
  line-height: var(--lh-normal);
}

.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--sp-2);
}
.metric {
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--c-gray-50);
}
.metric.bad {
  border-color: var(--danger);
  background: var(--danger-soft);
}
.m-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.m-name {
  font-size: var(--fs-12);
  color: var(--text-secondary);
}
.m-value {
  margin-top: var(--sp-1);
  font-size: var(--fs-28);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.m-desc {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  line-height: var(--lh-normal);
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  overflow-x: auto;
  padding-bottom: var(--sp-1);
}
.bar-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 26px;
}
.bar-track {
  width: 14px;
  height: 90px;
  background: var(--c-gray-200);
  border-radius: 3px;
  display: flex;
  align-items: flex-end;
  overflow: hidden;
}
.bar-fill {
  width: 100%;
  background: var(--success);
  border-radius: 3px;
}
.bar-fill.warn {
  background: var(--warning);
}
.bar-day,
.bar-tip {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.cell-main {
  font-size: var(--fs-13);
  font-weight: var(--fw-medium);
}
.cell-sub {
  font-size: var(--fs-12);
  color: var(--text-secondary);
}
.num {
  font-variant-numeric: tabular-nums;
}
.tbl-empty {
  padding: var(--sp-8) 0;
  text-align: center;
}
.te-title {
  margin: 0;
  font-size: var(--fs-13);
  color: var(--text-secondary);
}
.te-desc {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-12);
  color: var(--text-tertiary);
}
</style>
