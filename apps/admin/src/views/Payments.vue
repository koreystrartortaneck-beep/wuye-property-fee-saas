<template>
  <el-card class="mb">
    <template #header>线下缴费核销</template>
    <el-form inline>
      <el-form-item label="账单 ID">
        <el-input v-model="offline.billId" placeholder="待缴账单 ID" style="width: 220px" />
      </el-form-item>
      <el-form-item label="凭证号">
        <el-input v-model="offline.voucherNo" placeholder="收据/流水号" style="width: 160px" />
      </el-form-item>
      <el-form-item label="缴费时间">
        <el-date-picker v-model="offline.paidAt" type="datetime" placeholder="实际到账时间" style="width: 190px" />
      </el-form-item>
      <el-form-item label="缴款人">
        <el-input v-model="offline.payerName" placeholder="可选" style="width: 120px" />
      </el-form-item>
      <el-button type="primary" :loading="settling" @click="settleOffline">核销入账</el-button>
    </el-form>
    <el-alert
      type="info"
      :closable="false"
      title="线下核销会将账单标记为已缴并生成收据；若该账单已有进行中的微信订单，系统会先查单关单再核销。"
    />
  </el-card>

  <el-card>
    <template #header>支付流水</template>
    <div class="toolbar">
      <el-select v-model="filter.communityId" placeholder="小区" clearable style="width: 160px" @change="reload">
        <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-select v-model="filter.channel" placeholder="渠道" clearable style="width: 120px" @change="reload">
        <el-option v-for="(label, val) in PAYMENT_CHANNEL_LABEL" :key="val" :label="label" :value="val" />
      </el-select>
      <el-select v-model="filter.status" placeholder="状态" clearable style="width: 130px" @change="reload">
        <el-option v-for="(label, val) in PAYMENT_STATUS_LABEL" :key="val" :label="label" :value="val" />
      </el-select>
      <el-button @click="reload">查询</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="orderNo" label="订单号" min-width="180" />
      <el-table-column label="金额（元）" width="100">
        <template #default="{ row }">{{ yuan(row.totalAmount) }}</template>
      </el-table-column>
      <el-table-column label="渠道" width="90">
        <template #default="{ row }">{{ PAYMENT_CHANNEL_LABEL[row.channel] || row.channel }}</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="paymentStatusTag(row.status)">{{ PAYMENT_STATUS_LABEL[row.status] || row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="缴费时间" width="150">
        <template #default="{ row }">{{ dt(row.paidAt) }}</template>
      </el-table-column>
      <el-table-column label="凭证号" min-width="120">
        <template #default="{ row }">{{ row.offlineVoucherNo || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="220" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'SUCCESS' && row.channel !== 'OFFLINE'"
            size="small"
            type="danger"
            @click="openRefund(row)"
          >退款</el-button>
          <el-button
            v-if="row.status === 'SUCCESS' && row.channel === 'OFFLINE'"
            size="small"
            type="warning"
            @click="openReverse(row)"
          >冲正</el-button>
          <el-button size="small" @click="showRefund(row)">退款详情</el-button>
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
  </el-card>

  <!-- 退款 / 冲正 原因对话框（一次确认，强制原因） -->
  <el-dialog v-model="reasonDialog" :title="reasonTitle" width="440px">
    <el-form label-width="80px">
      <el-form-item label="订单号"><span>{{ current?.orderNo }}</span></el-form-item>
      <el-form-item label="金额"><span>¥{{ yuan(current?.totalAmount) }}（全额）</span></el-form-item>
      <el-form-item label="原因">
        <el-input v-model="reasonText" type="textarea" :rows="2" placeholder="必填，记入审计" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="reasonDialog = false">取消</el-button>
      <el-button type="danger" :loading="submitting" @click="submitReason">确认{{ reasonAction === 'refund' ? '退款' : '冲正' }}</el-button>
    </template>
  </el-dialog>

  <!-- 退款详情 -->
  <el-dialog v-model="refundDialog" title="退款详情" width="560px">
    <template v-if="refundDetail">
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="退款单号">{{ refundDetail.refundNo }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="refundStatusTag(refundDetail.status)">{{ REFUND_STATUS_LABEL[refundDetail.status] }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="退款金额">¥{{ yuan(refundDetail.refundAmount) }}</el-descriptions-item>
        <el-descriptions-item label="原金额">¥{{ yuan(refundDetail.originalAmount) }}</el-descriptions-item>
        <el-descriptions-item label="原因" :span="2">{{ refundDetail.reason }}</el-descriptions-item>
        <el-descriptions-item label="申请时间">{{ dt(refundDetail.requestedAt) }}</el-descriptions-item>
        <el-descriptions-item label="退款完成">{{ dt(refundDetail.refundedAt) }}</el-descriptions-item>
      </el-descriptions>
      <div class="json-title">退款尝试</div>
      <el-table :data="refundDetail.attempts || []" size="small">
        <el-table-column prop="attemptNo" label="#" width="50" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">{{ row.status }}</template>
        </el-table-column>
        <el-table-column label="时间" min-width="150">
          <template #default="{ row }">{{ dt(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="返回" min-width="140">
          <template #default="{ row }">{{ row.failureMessage || row.channelStatus || '—' }}</template>
        </el-table-column>
      </el-table>
    </template>
    <el-empty v-else description="该订单暂无退款记录" />
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';
import { useCommunities } from '../composables';
import {
  PAYMENT_STATUS_LABEL,
  PAYMENT_CHANNEL_LABEL,
  REFUND_STATUS_LABEL,
  paymentStatusTag,
  refundStatusTag,
  yuan,
  dt,
  buildRefundPayload,
  buildReasonPayload,
  buildOfflinePayload,
} from '../finance';

interface Payment {
  orderNo: string;
  totalAmount: string;
  channel: string;
  status: string;
  paidAt: string | null;
  offlineVoucherNo: string | null;
  receiptNo: string | null;
  billId: string | null;
}
interface Refund {
  refundNo: string;
  status: string;
  refundAmount: string;
  originalAmount: string;
  reason: string;
  requestedAt: string;
  refundedAt: string | null;
  attempts: { attemptNo: number; status: string; createdAt: string; failureMessage?: string; channelStatus?: string }[];
}

const { communities } = useCommunities();
const filter = ref({ communityId: '', channel: '', status: '' });
const rows = ref<Payment[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);

const offline = ref<{ billId: string; voucherNo: string; paidAt: string; payerName: string }>({
  billId: '',
  voucherNo: '',
  paidAt: '',
  payerName: '',
});
const settling = ref(false);

const reasonDialog = ref(false);
const reasonAction = ref<'refund' | 'reverse'>('refund');
const reasonText = ref('');
const current = ref<Payment | null>(null);
const submitting = ref(false);
const reasonTitle = computed(() => (reasonAction.value === 'refund' ? '发起全额退款' : '冲正线下缴费'));

const refundDialog = ref(false);
const refundDetail = ref<Refund | null>(null);

onMounted(load);

function reload() {
  page.value = 1;
  load();
}

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<Payment>>(`/admin/payments${qs({ ...filter.value, page: page.value, pageSize: 20 })}`);
    rows.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

async function settleOffline() {
  let payload;
  try {
    payload = buildOfflinePayload({
      billId: offline.value.billId.trim(),
      voucherNo: offline.value.voucherNo,
      paidAt: offline.value.paidAt,
      payerName: offline.value.payerName || undefined,
    });
  } catch (e) {
    return ElMessage.warning((e as Error).message);
  }
  settling.value = true;
  try {
    await api('/admin/payments/offline', { method: 'POST', body: payload });
    ElMessage.success('已核销入账');
    offline.value = { billId: '', voucherNo: '', paidAt: '', payerName: '' };
    await load();
  } finally {
    settling.value = false;
  }
}

function openRefund(row: Payment) {
  current.value = row;
  reasonAction.value = 'refund';
  reasonText.value = '';
  reasonDialog.value = true;
}

function openReverse(row: Payment) {
  current.value = row;
  reasonAction.value = 'reverse';
  reasonText.value = '';
  reasonDialog.value = true;
}

async function submitReason() {
  if (!current.value) return;
  submitting.value = true;
  try {
    if (reasonAction.value === 'refund') {
      const body = buildRefundPayload(current.value.orderNo, reasonText.value);
      await api('/admin/refunds', { method: 'POST', body });
      ElMessage.success('退款已发起');
    } else {
      const body = buildReasonPayload(reasonText.value);
      await api(`/admin/payments/${current.value.orderNo}/reverse-offline`, { method: 'POST', body });
      ElMessage.success('已冲正');
    }
    reasonDialog.value = false;
    await load();
  } catch (e) {
    if (e instanceof Error && (e.message.includes('原因'))) ElMessage.warning(e.message);
  } finally {
    submitting.value = false;
  }
}

async function showRefund(row: Payment) {
  refundDetail.value = null;
  refundDialog.value = true;
  try {
    refundDetail.value = await api<Refund>(`/admin/refunds/${row.orderNo}`, { silent: true });
  } catch {
    refundDetail.value = null;
  }
}
</script>

<style scoped>
.mb {
  margin-bottom: 16px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}
.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
.json-title {
  margin: 12px 0 6px;
  font-weight: 600;
  color: #102033;
}
</style>
