<template>
  <el-card class="mb">
    <template #header>线下缴费核销</template>
    <!--
      账单不是靠手输 ID 选的：从「收费 → 账单查询」里对某张待缴账单点「收现金」
      会带着 billId 跳到这里并回填。这条确认行让收费员在动钱之前先核对户与金额。
    -->
    <div v-if="billLabel" class="picked-bill">
      <span class="pb-tag">已选账单</span>
      <b class="pb-text">{{ billLabel }}</b>
      <el-button size="small" text @click="clearPickedBill">换一张</el-button>
    </div>
    <el-alert
      v-else
      class="mb"
      type="warning"
      :closable="false"
      show-icon
      title="请先到「收费 → 账单查询」找到这户的待缴账单，点该行的「收现金」再回来登记"
    >
      <template #default>
        <el-button size="small" type="primary" text @click="$router.push('/bills')">去选账单 →</el-button>
      </template>
    </el-alert>

    <el-form inline>
      <el-form-item label="账单 ID">
        <el-input v-model="offline.billId" placeholder="从账单查询点「收现金」自动带入" style="width: 220px" />
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
      <el-button type="primary" :loading="settling" :disabled="!offline.billId" @click="settleOffline">核销入账</el-button>
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
      <el-button :disabled="!rows.length" size="small" @click="doExport">导出本页</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" size="small">
      <el-table-column prop="orderNo" label="订单号" min-width="180" />
      <el-table-column label="金额（元）" width="100">
        <template #default="{ row }">{{ yuan(row.totalAmount) }}</template>
      </el-table-column>
      <el-table-column label="券抵扣（元）" width="120" align="right">
        <template #default="{ row }">
          <span v-if="Number(row.discountAmount) > 0" class="num discount">−{{ yuan(row.discountAmount) }}</span>
          <span v-else class="num muted">—</span>
        </template>
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
      <template #empty>
        <EmptyState
          icon="💰"
          title="还没有收款记录"
          desc="业主在小程序缴费、或物业登记线下现金后会出现在这里；退款与冲正也在本页操作"
          :action="{ label: '去出账让业主能缴费', to: '/bill-run' }"
        />
      </template>
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
  <el-dialog v-model="reasonDialog" :title="reasonTitle" width="min(440px, 92vw)">
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
  <el-dialog v-model="refundDialog" title="退款详情" width="min(560px, 92vw)">
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
          <template #default="{ row }">{{ REFUND_ATTEMPT_STATUS_LABEL[row.status] || '—' }}</template>
        </el-table-column>
        <el-table-column label="时间" min-width="150">
          <template #default="{ row }">{{ dt(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="返回" min-width="140">
          <template #default="{ row }">{{ row.failureMessage || row.channelStatus || '—' }}</template>
        </el-table-column>
              <template #empty>
          <EmptyState icon="↩️" title="还没有退款尝试" desc="发起退款后每次向微信提交的结果都会记录在此，失败可重试" />
        </template>
</el-table>
    </template>
    <el-empty v-else description="该订单暂无退款记录" />
  </el-dialog>
</template>

<script setup lang="ts">
import EmptyState from '../components/EmptyState.vue';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';
import { useCommunities } from '../composables';
import {
  PAYMENT_CHANNEL_LABEL,
  PAYMENT_STATUS_LABEL,
  REFUND_ATTEMPT_STATUS_LABEL,
  REFUND_STATUS_LABEL,
  buildOfflinePayload,
  buildReasonPayload,
  buildRefundPayload,
  day,
  dt,
  genRequestId,
  paymentStatusTag,
  refundStatusTag,
  yuan,
} from '../finance';
import { exportCsv } from '../export';

interface Payment {
  /** 优惠券抵扣额；totalAmount 为业主实付，二者之和为账单原额 */
  discountAmount?: string | null;
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
/** 线下核销幂等键：一次填表持有一把，成功后重置 */
const offlineRequestId = ref('');

/*
 * 由「账单查询 → 收现金」带入：billId 用于提交，billLabel 仅供核对展示。
 * 之前这里要求人工输入账单 cuid，而后台任何页面都不显示这串 ID，等于这条路走不通。
 */
const route = useRoute();
const billLabel = ref((route.query.billLabel as string) || '');
const offlineFromRoute = (route.query.billId as string) || '';
if (offlineFromRoute) offline.value.billId = offlineFromRoute;

function clearPickedBill() {
  billLabel.value = '';
  offline.value.billId = '';
}

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

/** 导出当前页收款流水，供财务核对 */
function doExport() {
  exportCsv(`收款流水-${day(new Date())}`, rows.value, [
    { header: '订单号', value: (p) => p.orderNo },
    { header: '实付金额(元)', value: (p) => yuan(p.totalAmount) },
    { header: '券抵扣(元)', value: (p) => (Number(p.discountAmount) > 0 ? yuan(p.discountAmount) : '') },
    { header: '渠道', value: (p) => PAYMENT_CHANNEL_LABEL[p.channel] || p.channel },
    { header: '状态', value: (p) => PAYMENT_STATUS_LABEL[p.status] || p.status },
    { header: '缴费时间', value: (p) => dt(p.paidAt) },
    { header: '凭证号', value: (p) => p.offlineVoucherNo ?? '' },
    { header: '收据号', value: (p) => p.receiptNo ?? '' },
  ]);
  ElMessage.success(`已导出 ${rows.value.length} 条`);
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
    if (!offlineRequestId.value) offlineRequestId.value = genRequestId('offline');
    payload = buildOfflinePayload({
      billId: offline.value.billId.trim(),
      voucherNo: offline.value.voucherNo,
      paidAt: offline.value.paidAt,
      payerName: offline.value.payerName || undefined,
    }, offlineRequestId.value);
  } catch (e) {
    return ElMessage.warning((e as Error).message);
  }
  settling.value = true;
  try {
    await api('/admin/payments/offline', { method: 'POST', body: payload });
    ElMessage.success('已核销入账');
    offline.value = { billId: '', voucherNo: '', paidAt: '', payerName: '' };
    offlineRequestId.value = '';
    await load();
  } finally {
    settling.value = false;
  }
}

/**
 * 幂等键在「打开对话框」时生成并持有到提交结束。
 * 若每次点击都新生成，提交超时后重试会被后端视为一次全新退款/冲正——
 * 这是直接动真钱的操作，必须让重试落在同一把键上。
 */
const opRequestId = ref('');

function openRefund(row: Payment) {
  current.value = row;
  reasonAction.value = 'refund';
  reasonText.value = '';
  opRequestId.value = genRequestId(`refund-${row.orderNo}`);
  reasonDialog.value = true;
}

function openReverse(row: Payment) {
  current.value = row;
  reasonAction.value = 'reverse';
  reasonText.value = '';
  opRequestId.value = genRequestId(`reverse-${row.orderNo}`);
  reasonDialog.value = true;
}

async function submitReason() {
  if (!current.value) return;
  submitting.value = true;
  try {
    if (reasonAction.value === 'refund') {
      const body = buildRefundPayload(current.value.orderNo, reasonText.value, opRequestId.value);
      await api('/admin/refunds', { method: 'POST', body });
      ElMessage.success('退款已发起');
    } else {
      const body = buildReasonPayload(reasonText.value, opRequestId.value);
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
/* 已选账单确认行：动钱之前必须让收费员看清是哪一户哪一笔 */
.picked-bill {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--c-gray-50);
  flex-wrap: wrap;
}
.pb-tag {
  padding: 2px var(--sp-2);
  border-radius: var(--r-full);
  background: var(--primary-soft);
  color: var(--primary);
  font-size: var(--fs-11);
  font-weight: var(--fw-semibold);
}
.pb-text {
  font-size: var(--fs-13);
  color: var(--text-primary);
}

.discount {
  color: var(--brand-gold);
  font-weight: var(--fw-medium);
}
.muted {
  color: var(--text-tertiary);
}
.json-title {
  margin: 12px 0 6px;
  font-weight: 600;
  color: var(--text-primary);
}
</style>
