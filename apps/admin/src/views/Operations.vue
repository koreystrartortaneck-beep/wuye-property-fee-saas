<template>
  <div v-loading="loading">
    <!--
      加载失败的横幅独立于内容块，且自带重试。
      原先「重新检查」按钮在 v-if="metrics" 的结论块里，metrics 拉失败时这块不渲染，
      页面上就没有任何重试入口了。
    -->
    <el-alert
      v-if="loadError"
      type="error"
      show-icon
      :closable="false"
      class="mb"
      :title="`${loadError}加载失败`"
      description="可能是后端暂时不可用或网络问题。下方显示的是上一次成功获取的数据（若有）。"
    >
      <template #default>
        <el-button size="small" :loading="loading" @click="load">重新检查</el-button>
      </template>
    </el-alert>

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
          <!--
            这两条是「真实还是模拟」的开关。曾经对账单渠道被绑成模拟实现、
            账期恒为空，把本地全部交易误判为「微信侧缺失」，而界面上没有任何
            地方能看出来，真金白银跑了一周才发现。所以必须在这里说清后果。
          -->
          <div v-if="!c.healthy && c.name === 'PAY_MODE'" class="ck-hint">
            在云托管环境变量中把 PAY_MODE 设为 wxpay，否则业主的缴费不会真正扣款。
          </div>
          <div v-if="!c.healthy && c.name === 'SCHEMA_MIGRATIONS'" class="ck-hint">
            容器启动时会自动执行 prisma migrate deploy。这一项不健康意味着有迁移没应用或应用失败，
            此时代码与数据库结构不匹配，可能出现字段缺失类报错——请查看云托管的启动日志。
          </div>
          <div v-if="!c.healthy && c.name === 'OUTBOX_DISPATCH'" class="ck-hint">
            把云托管环境变量 OUTBOX_DISPATCH_ENABLED 删掉或设为 true 即可恢复。
            关闭期间产生的通知事件不会丢，恢复后会按退避重试补投。
          </div>
          <div v-if="!c.healthy && c.name === 'NOTIFY_TEMPLATES'" class="ck-hint">
            到微信公众平台「功能 → 订阅消息」选用模板，把模板 ID 填到云托管环境变量
            WX_TMPL_BILL_CREATED / WX_TMPL_DUE_SOON / WX_TMPL_OVERDUE；
            小程序 config.js 的 subscribeTmplIds 也要填同一批，否则业主端不会弹授权。
            未配置时账单照样发布，但业主收不到任何提醒。
          </div>
          <div v-if="!c.healthy && c.name === 'RECONCILIATION_CHANNEL'" class="ck-hint">
            对账当前走的是模拟渠道：每天拉到的微信账单恒为空，于是本地每一笔交易
            都会被登记成「微信侧缺失」的假差异，而真实的资金差异（微信扣款成功但
            本地没记账、金额不一致）一笔也发现不了。它随 PAY_MODE 一同切换。
          </div>
        </div>
      </div>

      <!--
        订阅消息下发曾稳定失败于 `fetch failed`——网络层错误，界面上只有这四个字，
        无从判断是域名不可达、TLS 失败还是凭据不对。这里把探测能力直接给到运维手上。
      -->
      <div class="probe">
        <div class="probe-head">
          <b class="section-title">微信开放接口连通性</b>
          <span class="probe-desc">订阅消息、云存储都依赖 api.weixin.qq.com；发不出通知时先测这里</span>
          <el-button size="small" :loading="probing" @click="runProbe">开始检测</el-button>
        </div>
        <div v-if="probe" class="probe-body">
          <div class="probe-meta">
            WX_APPID {{ probe.appIdConfigured ? '已配置' : '未配置' }} ·
            WX_SECRET {{ probe.secretConfigured ? '已配置' : '未配置' }}
          </div>
          <div v-for="p in probe.probes" :key="p.name" class="probe-row">
            <span class="ck-icon" :class="p.ok ? 'ok' : 'bad'">{{ p.ok ? '✓' : '!' }}</span>
            <div class="probe-text">
              <div class="ck-name">{{ p.name }}<span class="probe-ms">{{ p.elapsedMs }}ms</span></div>
              <div class="ck-detail">{{ p.detail }}</div>
              <div class="probe-url">{{ p.url }}</div>
            </div>
          </div>
          <div class="ck-hint">
            只有 HTTPS 通 → 保持直连；只有 HTTP 通 → 云托管开放接口代理生效，需改用 HTTP 免鉴权调用；
            两个都不通 → 容器到 api.weixin.qq.com 不可达，或云托管「开放接口服务」未开通。
          </div>
        </div>
      </div>
    </el-card>

    <!-- 六项灰度指标 -->
    <el-card v-if="metrics" class="block">
      <template #header>关键指标（近 {{ metrics.windowDays }} 天）</template>
      <div class="card-grid">
        <div v-for="m in metricCards" :key="m.key" class="metric" :class="{ bad: !m.pass }">
          <div class="m-head">
            <span class="m-name">{{ m.name }}</span>
            <el-tag :type="m.pass ? 'success' : 'danger'" size="small" effect="light">
              {{ m.pass ? '达标' : '未达标' }}
            </el-tag>
          </div>
          <div class="stat-value">{{ m.display }}</div>
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
          <EmptyState
            icon="🟢"
            :title="incidentStatus === 'OPEN' ? '没有待处理的运营事件' : '没有运营事件'"
            desc="支付回调失败、对账差异、定时任务异常等会自动在此登记；配置告警 Webhook 后还会主动通知"
          />
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
import EmptyState from '../components/EmptyState.vue';
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, qs, type Page } from '../api';
import { dt } from '../finance';

/**
 * 后端两种指标形状不同：计数类给 value，比率类给 rate（外加 numerator/denominator）。
 * 此前这里只声明了 value，「支付技术成功率」「退款完成率」读到 undefined，
 * 被 pct() 的兜底渲染成「—」——页面上看起来像「暂无数据」，实际值是 100%。
 * 兜底把 bug 伪装成了正常状态，正是最难发现的一类。
 */
interface Gate {
  value?: number | boolean;
  rate?: number;
  numerator?: number;
  denominator?: number;
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
  /** 待投递却积压的通知事件；正常应为 0（投递任务每 30 秒跑一次） */
  outboxBacklog: number;
  /** 重试耗尽、已永久放弃的通知事件；不为 0 说明有业主该收到的通知彻底丢了 */
  outboxExhausted: number;
  /** 近 30 日发送失败的通知条数 */
  notifyFailedCount: number;
  notifyUnauthorizedCount: number;
  notifySystemFailedCount: number;
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

const CHECK_LABEL: Record<string, string> = {
  ALERT_DESTINATION: '异常告警推送地址',
  PAY_MODE: '支付模式',
  RECONCILIATION_CHANNEL: '对账数据来源',
  SCHEMA_MIGRATIONS: '数据库结构版本',
  OUTBOX_DISPATCH: '通知投递任务',
  NOTIFY_TEMPLATES: '业主通知模板',
};
const SEVERITY_LABEL: Record<string, string> = { INFO: '提示', WARNING: '警告', CRITICAL: '严重' };
const INCIDENT_STATUS_LABEL: Record<string, string> = {
  OPEN: '待处理',
  ACKNOWLEDGED: '已确认',
  RESOLVED: '已解决',
};

const metrics = ref<Metrics | null>(null);
/*
 * 加载失败必须有自己的状态与重试入口。
 * 原先失败时 metrics 保持 null，而「重新检查」按钮长在 v-if="metrics" 的那块里，
 * 于是失败之后页面上再没有任何地方能重试——只能刷新整页。
 */
const loadError = ref('');
const readiness = ref<Readiness | null>(null);

interface WxProbe {
  appIdConfigured: boolean;
  secretConfigured: boolean;
  probes: { name: string; url: string; ok: boolean; httpStatus: number | null; detail: string; elapsedMs: number }[];
}
const probe = ref<WxProbe | null>(null);
const probing = ref(false);

/** 手动触发连通性探测：两次网络请求，各 6 秒超时，不放在页面加载里跑 */
async function runProbe() {
  probing.value = true;
  try {
    probe.value = await api<WxProbe>('/admin/operations/wx-probe');
  } finally {
    probing.value = false;
  }
}
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
      display: pct(m.paymentTechnicalSuccessRate.rate),
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
      display: String(m.duplicateChargeCount.value ?? 0),
      pass: m.duplicateChargeCount.pass,
      desc: '同一账单被收多次的笔数，必须为 0',
    },
    {
      key: 'recon',
      name: '未处置对账差异',
      display: String(m.unresolvedReconciliationDifferences.value ?? 0),
      pass: m.unresolvedReconciliationDifferences.pass,
      desc: '与微信支付核对不上且未处理的条目',
    },
    {
      key: 'refund',
      name: '退款完成率',
      display: pct(m.refundCompletionRate.rate),
      pass: m.refundCompletionRate.pass,
      desc: `门槛 ${pct(m.refundCompletionRate.threshold)}`,
    },
    {
      key: 'incident',
      name: '严重事件',
      display: String(m.severeIncidentCount.value ?? 0),
      pass: m.severeIncidentCount.pass,
      desc: '近期发生的严重级运营事件数',
    },
    /*
     * 通知投递此前完全没有监控：事件重试耗尽后变成 FAILED 永久沉在库里，
     * 业主该收到的账单/催缴无声无息地丢了，后台任何页面都看不出异常。
     */
    {
      key: 'outbox',
      name: '通知积压',
      display: String(m.outboxBacklog),
      pass: m.outboxBacklog === 0,
      desc: '已到点却还没投出去的通知；投递任务每 30 秒一轮，正常应为 0',
    },
    {
      key: 'outboxDead',
      name: '通知永久丢失',
      display: String(m.outboxExhausted),
      pass: m.outboxExhausted === 0,
      desc: '重试 5 次仍失败被放弃的通知；不为 0 意味着有业主没收到本该收到的账单',
    },
    {
      /*
       * 拆成两个数，因为它们要人做的事完全不同。
       *
       * 微信一次性订阅：业主授权一次只能收一条，额度用完再发就是 43101。
       * 这不是故障 —— 要做的是引导业主重新授权，不是查系统。
       * 生产实测 15 条失败里绝大多数是它。
       *
       * 混在一起的后果不是「数字难看」，而是真故障被埋掉：
       * 模板 ID 配错、openid 失效这些必须有人处理的失败，
       * 夹在十几条 43101 里没人会发现。所以只有「系统故障」那一项判红。
       */
      key: 'notifySystemFailed',
      name: '通知系统故障',
      display: String(m.notifySystemFailedCount),
      pass: m.notifySystemFailedCount === 0,
      desc: `近 ${m.windowDays} 日中排除「业主未授权」后仍失败的条数；不为 0 需要排查模板配置或网络`,
    },
    {
      key: 'notifyUnauthorized',
      name: '业主未授权提醒',
      display: String(m.notifyUnauthorizedCount),
      // 不判红：这不是故障，是微信一次性订阅的固有限制
      pass: true,
      desc: `近 ${m.windowDays} 日因业主未授权/额度用尽（微信 43101）发不出去的条数；`
        + `需引导业主在「我的 → 开启缴费提醒」重新授权，不是系统问题`,
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
  loadError.value = '';
  try {
    /*
     * allSettled 而不是 all：两个接口互不依赖，用 all 时任一失败会让**两块**都不
     * 显示——而运维页恰恰是出问题时才来看的，指标接口失败往往正说明后端有事，
     * 此时更需要看到就绪度那一块。
     */
    const [m, r] = await Promise.allSettled([
      api<Metrics>('/admin/operations/metrics'),
      api<Readiness>('/admin/operations/readiness'),
    ]);
    if (m.status === 'fulfilled') metrics.value = m.value;
    if (r.status === 'fulfilled') readiness.value = r.value;
    const failed: string[] = [];
    if (m.status === 'rejected') failed.push('运行指标');
    if (r.status === 'rejected') failed.push('配置就绪度');
    if (failed.length) loadError.value = failed.join('、');
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await Promise.all([load(), loadIncidents()]);
});
</script>

<style scoped>
/* ---------- 微信接口连通性探测 ---------- */
.probe {
  margin-top: var(--sp-4);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--border);
}
.probe-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.probe-desc {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-12);
  color: var(--text-tertiary);
}
.probe-body {
  margin-top: var(--sp-3);
}
.probe-meta {
  margin-bottom: var(--sp-2);
  font-size: var(--fs-12);
  color: var(--text-tertiary);
}
.probe-row {
  display: flex;
  gap: var(--sp-2);
  padding: var(--sp-2) 0;
}
.probe-text {
  min-width: 0;
}
.probe-ms {
  margin-left: var(--sp-2);
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.probe-url {
  margin-top: 2px;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  word-break: break-all;
}

.verdict {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-4);
  border-radius: var(--r-lg);
  background: var(--bg-card);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
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
  /*
   * .el-card__header 是 flex 容器（见 styles/ui.css），flex 子项上的 float 会被浏览器
   * 完全忽略——这条 float: right 一直是空操作，元素其实是靠 flex 的默认排列落在那里的。
   */
  margin-left: auto;
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

</style>
