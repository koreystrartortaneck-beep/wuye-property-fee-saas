<template>
  <!-- 概览：一眼看到欠多少、多少户 -->
  <div class="sum-bar">
    <div class="stat">
      <span class="stat-label">欠费合计</span>
      <b class="stat-value">¥{{ totalAmount }}</b>
    </div>
    <div class="stat">
      <span class="stat-label">欠费户数</span>
      <b class="stat-value">{{ totalHouses }}</b>
    </div>
    <div class="stat">
      <span class="stat-label">其中已逾期</span>
      <b class="stat-value" :class="{ 'is-bad': overdueHouses > 0 }">{{ overdueHouses }}</b>
    </div>
  </div>

  <!--
    明细被截断时必须说清楚。上方三个数字是全量真值（服务端按户聚合得出），
    但下面的表格与导出只有前 500 户——不说明的话，收费员会以为导出的就是全部。
  -->
  <el-alert
    v-if="truncated"
    type="warning"
    show-icon
    :closable="false"
    class="mb"
    title="欠费户数较多，下方明细与导出只包含欠费金额最高的前 500 户"
    :description="`上方「欠费合计 ¥${totalAmount}」与「欠费户数 ${totalHouses}」是全量数字，不受此限制。需要完整名单请按小区分别导出。`"
  />

  <el-card>
    <div class="toolbar">
      <div v-if="communities.length > 1" class="field">
        <label>小区</label>
        <el-select v-model="filter.communityId" placeholder="全部小区" clearable style="width: 150px" @change="reload">
          <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </div>
      <div class="field">
        <label>逾期天数</label>
        <el-select v-model="filter.overdueDays" style="width: 140px" @change="reload">
          <el-option label="全部欠费" :value="undefined" />
          <el-option label="已逾期" :value="1" />
          <el-option label="逾期超 15 天" :value="15" />
          <el-option label="逾期超 30 天" :value="30" />
          <el-option label="逾期超 90 天" :value="90" />
        </el-select>
      </div>
      <div class="field">
        <label>排序</label>
        <el-select v-model="filter.sort" style="width: 130px" @change="reload">
          <el-option label="欠费金额" value="amount" />
          <el-option label="逾期天数" value="days" />
        </el-select>
      </div>
      <div class="toolbar-right">
        <el-button :disabled="!rows.length" @click="doExport">导出表格</el-button>
        <el-button
          type="primary"
          :disabled="!selected.length"
          :loading="dunning"
          @click="dun"
        >催缴选中（{{ selected.length }} 户）</el-button>
      </div>
    </div>

    <el-table
      ref="selectionRef"
      v-loading="loading"
      :data="rows"
      row-key="houseId"
      @selection-change="(v: Row[]) => (selected = v)"
    >
      <el-table-column type="selection" width="46" reserve-selection />

      <el-table-column label="房屋 / 业主" min-width="200">
        <template #default="{ row }">
          <div class="cell-main">{{ row.displayName || row.code }}</div>
          <div class="cell-sub">
            {{ row.ownerName || '未登记业主' }}
            <template v-if="row.ownerPhone"> · {{ row.ownerPhone }}</template>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="欠费金额（元）" width="130" align="right">
        <template #default="{ row }"><span class="num money">{{ yuan(row.unpaidAmount) }}</span></template>
      </el-table-column>

      <el-table-column label="笔数" width="80" align="right">
        <template #default="{ row }"><span class="num">{{ row.unpaidCount }}</span></template>
      </el-table-column>

      <el-table-column label="欠费账期" min-width="160">
        <template #default="{ row }"><span class="cell-sub">{{ row.periods.join('、') }}</span></template>
      </el-table-column>

      <el-table-column label="逾期" width="120">
        <template #default="{ row }">
          <el-tag v-if="row.overdueDays > 0" type="danger" size="small" effect="light">
            已逾期 {{ row.overdueDays }} 天
          </el-tag>
          <span v-else class="cell-sub">未到期</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="viewBills(row)">查档案</el-button>
        </template>
      </el-table-column>

      <!-- 空状态分两种：筛掉了 vs 真的没欠费。前者给「清除筛选」，后者是好消息不需要动作 -->
      <template #empty>
        <EmptyState
          v-if="filter.overdueDays"
          icon="🔎"
          title="没有符合条件的欠费业主"
          desc="当前按「逾期天数」做了筛选，放宽条件可以看到更多"
        >
          <template #action><el-button @click="clearFilter">清除筛选</el-button></template>
        </EmptyState>
        <EmptyState
          v-else
          icon="✅"
          title="太好了，当前没有欠费"
          desc="发布账单后，未缴清的业主会自动出现在这里"
        />
      </template>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import EmptyState from '../components/EmptyState.vue';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, qs } from '../api';
import { useCommunities } from '../composables';
import { day, genRequestId, yuan } from '../finance';
import { exportCsv } from '../export';

interface Row {
  houseId: string;
  code: string;
  displayName: string;
  ownerName: string | null;
  ownerPhone: string | null;
  unpaidCount: number;
  unpaidAmount: string;
  earliestDueDate: string | null;
  overdueDays: number;
  periods: string[];
}

const router = useRouter();
const { communities } = useCommunities();
const filter = ref<{ communityId: string; overdueDays?: number; sort: 'amount' | 'days' }>({
  communityId: '',
  overdueDays: undefined,
  sort: 'amount',
});
const rows = ref<Row[]>([]);
const totalAmount = ref('0.00');
const totalHouses = ref(0);
const loading = ref(false);
const selected = ref<Row[]>([]);
const dunning = ref(false);
/** 表格实例：催缴成功后要清掉 reserve-selection 保留的勾选 */
const selectionRef = ref<{ clearSelection(): void } | null>(null);
/** 本次催缴的幂等键，成功后清空 */
let dunRequestId = '';

/*
 * 三个概览数字全部取自服务端的全量聚合。
 * 原先「其中已逾期」用 rows.value.filter(...) 现算，而 rows 是截断后的明细，
 * 于是这个数字会随明细一起少报。
 */
const overdueHouses = ref(0);
const truncated = ref(false);

/**
 * 换筛选条件时必须先清掉勾选。
 *
 * 表格开了 reserve-selection（按 row-key 跨数据刷新保留勾选），这本是为了翻页时
 * 不丢选择；但配上「筛选后直接 load」就有真实后果：勾了 A 小区的 20 户，切到
 * B 小区，那 20 户仍在 selected 里，点「批量催缴」会给已经不在视野里的业主发提醒，
 * 而操作者以为自己发的是当前列表。
 */
async function reload() {
  selectionRef.value?.clearSelection();
  selected.value = [];
  dunRequestId = '';
  await load();
}

/** 空状态里的「清除筛选」：只清逾期天数（小区不是筛选，是必选维度） */
function clearFilter() {
  filter.value.overdueDays = undefined;
  void load();
}

async function load() {
  loading.value = true;
  try {
    const res = await api<{
      list: Row[];
      totalAmount: string;
      totalHouses: number;
      overdueHouses: number;
      truncated: boolean;
    }>(
      `/admin/arrears${qs({
        communityId: filter.value.communityId || undefined,
        overdueDays: filter.value.overdueDays,
        sort: filter.value.sort,
      })}`,
    );
    rows.value = res.list ?? [];
    totalAmount.value = res.totalAmount ?? '0.00';
    totalHouses.value = res.totalHouses ?? 0;
    overdueHouses.value = res.overdueHouses ?? 0;
    truncated.value = !!res.truncated;
  } finally {
    loading.value = false;
  }
}

function viewBills(row: Row) {
  // 进业主档案而非账单列表：催缴时要同时看到欠费、缴费历史与联系方式
  void router.push(`/houses/${row.houseId}`);
}

/** 批量催缴：走后端幂等接口，逐笔触发逾期提醒 */
async function dun() {
  const houseIds = selected.value.map((r) => r.houseId);
  if (!houseIds.length) return;
  const amount = yuan(selected.value.reduce((s, r) => s + Number(r.unpaidAmount || 0), 0));
  try {
    await ElMessageBox.confirm(
      `将向 ${houseIds.length} 户业主推送催缴提醒（合计欠费 ¥${amount}）。\n` +
        '业主需已在小程序订阅过缴费提醒才会收到，未订阅的会被跳过。',
      '确认批量催缴',
      { type: 'warning', confirmButtonText: '发送催缴', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  dunning.value = true;
  // 幂等键在这一次操作内固定：原先在 body 里现调 genRequestId，网络重试会换键，
  // 于是同一批催缴被当成两次不同的请求。
  if (!dunRequestId) dunRequestId = genRequestId('dun');
  try {
    const res = await api<{ queued: number; houses: number; skipped: number }>('/admin/arrears/dun', {
      method: 'POST',
      body: { houseIds, requestId: dunRequestId },
    });
    /*
     * 文案必须说「已排入队列」而不是「已发送」。
     * 后端改为落 Outbox 事件、由投递任务在 30 秒内发出（原先请求内串行发 3600 次
     * 微信调用需要约 720 秒，网关早就超时，而幂等记录停在 PROCESSING，这个按钮
     * 此后永远显示「催缴正在处理中」）。此刻消息还没真的发出去，说「已发送」是假话。
     */
    ElMessage.success(
      `已为 ${res.houses} 户排入 ${res.queued} 条催缴提醒，约 30 秒内发出` +
        (res.skipped > 0 ? `；${res.skipped} 条跳过（这些账单的同类提醒已发过）` : '') +
        '。发送结果可在「通知记录」查看。',
    );
    // 发完就清掉选择并重新加载：不清的话勾选会跨筛选保留（reserve-selection），
    // 下一次点催缴可能把已经被筛掉的业主又发一遍。
    selectionRef.value?.clearSelection();
    selected.value = [];
    dunRequestId = '';
    await load();
  } finally {
    dunning.value = false;
  }
}

/** 导出当前清单，供线下催缴与交报表用 */
function doExport() {
  exportCsv(`欠费清单-${day(new Date())}`, rows.value, [
    { header: '房号', value: (r) => r.code },
    { header: '房屋', value: (r) => r.displayName },
    { header: '业主', value: (r) => r.ownerName },
    { header: '手机号', value: (r) => r.ownerPhone },
    { header: '欠费金额（元）', value: (r) => yuan(r.unpaidAmount) },
    { header: '笔数', value: (r) => r.unpaidCount },
    { header: '欠费账期', value: (r) => r.periods.join(' ') },
    { header: '逾期天数', value: (r) => r.overdueDays },
    { header: '最早到期日', value: (r) => (r.earliestDueDate ? day(r.earliestDueDate) : '') },
  ]);
  ElMessage.success(`已导出 ${rows.value.length} 条`);
}

onMounted(load);
</script>

<style scoped>
.sum-bar {
  display: flex;
  gap: var(--sp-8);
  padding: var(--sp-4);
  margin-bottom: var(--sp-3);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-card);
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
  display: flex;
  gap: var(--sp-2);
}

</style>
