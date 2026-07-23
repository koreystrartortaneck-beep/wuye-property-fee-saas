<template>
  <el-card class="mb">
    <template #header>发起对账</template>
    <el-form inline>
      <el-form-item label="商户账户 ID">
        <el-input v-model="trigger.merchantAccountId" placeholder="merchantAccountId" style="width: 180px" />
      </el-form-item>
      <el-form-item label="mchid"><el-input v-model="trigger.mchid" style="width: 140px" /></el-form-item>
      <el-form-item label="appid"><el-input v-model="trigger.appid" style="width: 150px" /></el-form-item>
      <el-form-item label="账单类型">
        <el-select v-model="trigger.billType" style="width: 130px">
          <el-option v-for="(label, val) in RECON_BILL_TYPE_LABEL" :key="val" :label="label" :value="val" />
        </el-select>
      </el-form-item>
      <el-form-item label="账单日期">
        <el-date-picker v-model="trigger.businessDate" type="date" placeholder="账单日" style="width: 150px" />
      </el-form-item>
      <el-button type="primary" :loading="triggering" @click="doTrigger">对账</el-button>
    </el-form>
    <el-alert type="info" :closable="false" title="每日对账通常由定时任务自动执行；此处用于手动补对某个账单日。微信账单一般次日才可下载。" />
  </el-card>

  <el-card>
    <template #header>对账批次</template>
    <el-table :data="runs" v-loading="loading" size="small">
      <el-table-column prop="runNo" label="对账单号" min-width="150" />
      <el-table-column label="账单日" width="110">
        <template #default="{ row }">{{ day(row.businessDate) }}</template>
      </el-table-column>
      <el-table-column label="类型" width="90">
        <template #default="{ row }">{{ RECON_BILL_TYPE_LABEL[row.billType] || row.billType }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="reconRunStatusTag(row.status)">{{ RECON_RUN_STATUS_LABEL[row.status] || row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="渠道/本地笔数" width="130">
        <template #default="{ row }">{{ row.channelRecordCount }} / {{ row.localRecordCount }}</template>
      </el-table-column>
      <el-table-column label="差异笔数" width="90">
        <template #default="{ row }">
          <span :class="{ warn: row.differenceRecordCount > 0 }">{{ row.differenceRecordCount }}</span>
        </template>
      </el-table-column>
      <el-table-column label="开始时间" width="150">
        <template #default="{ row }">{{ dt(row.startedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="90">
        <template #default="{ row }">
          <el-button size="small" @click="openItems(row)">明细</el-button>
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

    <el-dialog v-model="itemsDialog" title="对账差异明细" width="720px">
      <el-table :data="items" v-loading="itemsLoading" size="small">
        <el-table-column prop="orderNo" label="订单号" min-width="160" />
        <el-table-column label="差异类型" width="110">
          <template #default="{ row }">{{ RECON_DIFF_LABEL[row.differenceType] || row.differenceType }}</template>
        </el-table-column>
        <el-table-column label="本地/渠道金额" width="140">
          <template #default="{ row }">{{ money(row.localAmount) }} / {{ money(row.channelAmount) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="reconItemStatusTag(row.status)">{{ RECON_ITEM_STATUS_LABEL[row.status] || row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button v-if="row.status === 'OPEN'" size="small" @click="openResolve(row)">处置</el-button>
            <span v-else class="sub">{{ row.handlingRemark || '已处置' }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog v-model="resolveDialog" title="处置对账差异" width="440px">
      <el-form label-width="90px">
        <el-form-item label="处置方式">
          <el-select v-model="resolve.status" style="width: 100%">
            <el-option label="人工关闭（已核实无误）" value="MANUALLY_CLOSED" />
            <el-option label="升级（需进一步排查）" value="ESCALATED" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="resolve.remark" type="textarea" :rows="2" placeholder="处置说明" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="resolveDialog = false">取消</el-button>
        <el-button type="primary" :loading="resolving" @click="submitResolve">确认</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';
import {
  RECON_RUN_STATUS_LABEL,
  RECON_BILL_TYPE_LABEL,
  RECON_DIFF_LABEL,
  RECON_ITEM_STATUS_LABEL,
  reconRunStatusTag,
  reconItemStatusTag,
  dt,
  day,
} from '../finance';

interface Run {
  id: string;
  runNo: string;
  businessDate: string;
  billType: string;
  status: string;
  channelRecordCount: number;
  localRecordCount: number;
  differenceRecordCount: number;
  startedAt: string;
}
interface Item {
  id: string;
  orderNo: string;
  differenceType: string;
  status: string;
  localAmount: string | null;
  channelAmount: string | null;
  handlingRemark: string | null;
}

const runs = ref<Run[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);

const trigger = ref<{ merchantAccountId: string; mchid: string; appid: string; billType: string; businessDate: string }>({
  merchantAccountId: '',
  mchid: '',
  appid: '',
  billType: 'TRANSACTION',
  businessDate: '',
});
const triggering = ref(false);

const itemsDialog = ref(false);
const itemsLoading = ref(false);
const items = ref<Item[]>([]);
const currentRun = ref<Run | null>(null);

const resolveDialog = ref(false);
const resolving = ref(false);
const currentItem = ref<Item | null>(null);
const resolve = ref({ status: 'MANUALLY_CLOSED', remark: '' });

onMounted(load);

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<Run>>(`/admin/reconciliations${qs({ page: page.value, pageSize: 20 })}`);
    runs.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

function money(v: string | null): string {
  return v === null || v === undefined ? '—' : Number(v).toFixed(2);
}

async function doTrigger() {
  const t = trigger.value;
  if (!t.merchantAccountId.trim() || !t.mchid.trim() || !t.appid.trim() || !t.businessDate) {
    return ElMessage.warning('请填写商户账户、mchid、appid 与账单日期');
  }
  triggering.value = true;
  try {
    await api('/admin/reconciliations', {
      method: 'POST',
      body: {
        merchantAccountId: t.merchantAccountId.trim(),
        mchid: t.mchid.trim(),
        appid: t.appid.trim(),
        billType: t.billType,
        businessDate: new Date(t.businessDate).toISOString(),
      },
    });
    ElMessage.success('对账已发起');
    await load();
  } finally {
    triggering.value = false;
  }
}

async function openItems(row: Run) {
  currentRun.value = row;
  itemsDialog.value = true;
  itemsLoading.value = true;
  items.value = [];
  try {
    const data = await api<Page<Item>>(`/admin/reconciliations/${row.id}/items${qs({ page: 1, pageSize: 200 })}`);
    items.value = data.list;
  } finally {
    itemsLoading.value = false;
  }
}

function openResolve(row: Item) {
  currentItem.value = row;
  resolve.value = { status: 'MANUALLY_CLOSED', remark: '' };
  resolveDialog.value = true;
}

async function submitResolve() {
  if (!currentItem.value) return;
  resolving.value = true;
  try {
    await api(`/admin/reconciliations/items/${currentItem.value.id}/resolve`, {
      method: 'POST',
      body: { status: resolve.value.status, remark: resolve.value.remark || undefined },
    });
    ElMessage.success('已处置');
    resolveDialog.value = false;
    if (currentRun.value) await openItems(currentRun.value);
    await load();
  } finally {
    resolving.value = false;
  }
}
</script>

<style scoped>
.mb {
  margin-bottom: 16px;
}
.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
.warn {
  color: #c45656;
  font-weight: 600;
}
.sub {
  color: #8a7f73;
  font-size: 12px;
}
</style>
