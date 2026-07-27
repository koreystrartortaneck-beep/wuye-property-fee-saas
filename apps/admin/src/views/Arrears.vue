<template>
  <!-- 概览：一眼看到欠多少、多少户 -->
  <div class="sum-bar">
    <div class="sum-item">
      <span class="sum-label">欠费合计</span>
      <b class="sum-value strong num">¥{{ totalAmount }}</b>
    </div>
    <div class="sum-item">
      <span class="sum-label">欠费户数</span>
      <b class="sum-value num">{{ totalHouses }}</b>
    </div>
    <div class="sum-item">
      <span class="sum-label">其中已逾期</span>
      <b class="sum-value num" :class="{ bad: overdueHouses > 0 }">{{ overdueHouses }}</b>
    </div>
  </div>

  <el-card>
    <div class="toolbar">
      <div v-if="communities.length > 1" class="field">
        <label>小区</label>
        <el-select v-model="filter.communityId" placeholder="全部小区" clearable style="width: 150px" @change="load">
          <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </div>
      <div class="field">
        <label>逾期天数</label>
        <el-select v-model="filter.overdueDays" style="width: 140px" @change="load">
          <el-option label="全部欠费" :value="undefined" />
          <el-option label="已逾期" :value="1" />
          <el-option label="逾期超 15 天" :value="15" />
          <el-option label="逾期超 30 天" :value="30" />
          <el-option label="逾期超 90 天" :value="90" />
        </el-select>
      </div>
      <div class="field">
        <label>排序</label>
        <el-select v-model="filter.sort" style="width: 130px" @change="load">
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

      <template #empty>
        <div class="tbl-empty">
          <p class="te-title">{{ filter.overdueDays ? '没有符合条件的欠费住户' : '太好了，当前没有欠费' }}</p>
          <p class="te-desc">发布账单后，未缴清的住户会自动出现在这里</p>
        </div>
      </template>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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

const overdueHouses = computed(() => rows.value.filter((r) => r.overdueDays > 0).length);

async function load() {
  loading.value = true;
  try {
    const res = await api<{ list: Row[]; totalAmount: string; totalHouses: number }>(
      `/admin/arrears${qs({
        communityId: filter.value.communityId || undefined,
        overdueDays: filter.value.overdueDays,
        sort: filter.value.sort,
      })}`,
    );
    rows.value = res.list ?? [];
    totalAmount.value = res.totalAmount ?? '0.00';
    totalHouses.value = res.totalHouses ?? 0;
  } finally {
    loading.value = false;
  }
}

function viewBills(row: Row) {
  // 进住户档案而非账单列表：催缴时要同时看到欠费、缴费历史与联系方式
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
  try {
    const res = await api<{ notified: number; houses: number; skipped: number }>('/admin/arrears/dun', {
      method: 'POST',
      body: { houseIds, requestId: genRequestId('dun') },
    });
    ElMessage.success(
      `已向 ${res.houses} 户发送 ${res.notified} 条催缴提醒` +
        (res.skipped > 0 ? `，${res.skipped} 条未发出（业主未订阅提醒）` : ''),
    );
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
    { header: '欠费金额(元)', value: (r) => yuan(r.unpaidAmount) },
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
  border-radius: var(--r-md);
  box-shadow: var(--shadow-sm);
  flex-wrap: wrap;
}
.sum-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sum-label {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}
.sum-value {
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}
.sum-value.strong {
  font-size: var(--fs-28);
}
.sum-value.bad {
  color: var(--danger-text);
}

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
  display: flex;
  gap: var(--sp-2);
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
.num {
  font-variant-numeric: tabular-nums;
}
.money {
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
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
