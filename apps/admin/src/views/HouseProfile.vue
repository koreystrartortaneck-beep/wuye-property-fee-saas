<template>
  <div v-loading="loading">
    <!-- 房屋与业主：接电话时第一眼要看到的 -->
    <div v-if="data" class="hero">
      <div class="hero-main">
        <h2 class="hero-title">{{ data.house.displayName || data.house.code }}</h2>
        <div class="hero-meta">
          {{ data.house.communityName }} · {{ data.house.code }}
          <template v-if="data.house.area"> · {{ data.house.area }} ㎡</template>
          <template v-if="houseTypeText"> · {{ houseTypeText }}</template>
        </div>
        <div class="hero-owner">
          <span>{{ data.house.ownerName || '未登记业主' }}</span>
          <span v-if="data.house.ownerPhone" class="hero-phone">{{ data.house.ownerPhone }}</span>
          <el-tag v-if="data.house.status !== 'ACTIVE'" type="info" size="small">已停用</el-tag>
        </div>
      </div>

      <div class="stat-row">
        <div class="stat">
          <span class="stat-label">待缴</span>
          <b class="stat-value" :class="{ 'is-bad': Number(data.summary.unpaidAmount) > 0 }">
            ¥{{ yuan(data.summary.unpaidAmount) }}
          </b>
          <span class="fig-sub">{{ data.summary.unpaidCount }} 笔</span>
        </div>
        <div class="stat">
          <span class="stat-label">已缴</span>
          <b class="stat-value">¥{{ yuan(data.summary.paidAmount) }}</b>
          <span class="fig-sub">{{ data.summary.paidCount }} 笔</span>
        </div>
      </div>

      <div class="hero-actions">
        <el-button v-if="data.summary.unpaidCount > 0" type="primary" @click="goSettle">登记现金收款</el-button>
        <el-button @click="goBills">查全部账单</el-button>
      </div>
    </div>

    <!-- 待处理提醒 -->
    <el-alert
      v-if="data && (data.summary.pendingBindings > 0 || data.summary.openTickets > 0)"
      type="warning"
      :closable="false"
      show-icon
      class="todo-alert"
      :title="todoText"
    />

    <el-tabs v-if="data" v-model="tab" class="pf-tabs">
      <el-tab-pane :label="`账单（${data.bills.length}）`" name="bills">
        <el-table :data="data.bills" size="small" max-height="420">
          <el-table-column label="费用" min-width="180">
            <template #default="{ row }">
              <div class="cell-main">{{ row.title }}</div>
              <div class="cell-sub">{{ row.period }}</div>
            </template>
          </el-table-column>
          <el-table-column label="怎么算的" min-width="150">
            <template #default="{ row }"><span class="cell-sub">{{ calcText(row) }}</span></template>
          </el-table-column>
          <el-table-column label="金额（元）" width="110" align="right">
            <template #default="{ row }"><span class="num money">{{ yuan(row.amount) }}</span></template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="billStatusTag(row.status)" size="small" effect="light">
                {{ BILL_STATUS_LABEL[row.status] || row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="时间" min-width="140">
            <template #default="{ row }">
              <span class="cell-sub">
                {{ row.status === 'PAID' && row.paidAt ? `缴于 ${day(row.paidAt)}` : `到期 ${day(row.dueDate)}` }}
              </span>
            </template>
          </el-table-column>
          <!--
            接电话时最常见的动作就是「业主说交现金了」，所以每张待缴账单
            这里直接给入口，带 billId 跳收款页。原先只有卡头一个按钮，
            而它传的是 houseId、收款页并不识别，点了等于没反应。
          -->
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'UNPAID'"
                size="small"
                type="primary"
                plain
                @click="settleBill(row)"
              >收现金</el-button>
            </template>
          </el-table-column>
          <template #empty><div class="pf-empty">这户还没有账单</div></template>
        </el-table>
      </el-tab-pane>

      <el-tab-pane :label="`缴费记录（${data.payments.length}）`" name="payments">
        <el-table :data="data.payments" size="small" max-height="420">
          <el-table-column label="订单号" min-width="180">
            <template #default="{ row }">
              <div class="cell-main">{{ row.orderNo }}</div>
              <div class="cell-sub">{{ PAYMENT_CHANNEL_LABEL[row.channel] || row.channel }}</div>
            </template>
          </el-table-column>
          <el-table-column label="金额（元）" width="110" align="right">
            <template #default="{ row }"><span class="num money">{{ yuan(row.totalAmount) }}</span></template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :type="paymentStatusTag(row.status)" size="small" effect="light">
                {{ PAYMENT_STATUS_LABEL[row.status] || row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="缴费时间" min-width="150">
            <template #default="{ row }"><span class="cell-sub">{{ dt(row.paidAt) }}</span></template>
          </el-table-column>
          <el-table-column label="收据号" min-width="140">
            <template #default="{ row }"><span class="cell-sub">{{ row.receiptNo || '—' }}</span></template>
          </el-table-column>
          <template #empty><div class="pf-empty">这户还没有缴费记录</div></template>
        </el-table>
      </el-tab-pane>

      <el-tab-pane :label="`实名绑定（${data.bindings.length}）`" name="bindings">
        <el-table :data="data.bindings" size="small" max-height="420">
          <el-table-column label="申请人 / 微信" min-width="180">
            <template #default="{ row }">
              <div class="cell-main">{{ row.applicantName || row.wxUser?.nickname || '未填姓名' }}</div>
              <div class="cell-sub">{{ row.wxUser?.phone || '未获取手机号' }}</div>
            </template>
          </el-table-column>
          <el-table-column label="关系" width="90">
            <template #default="{ row }">{{ BINDING_RELATION_LABEL[row.relation] || row.relation }}</template>
          </el-table-column>
          <el-table-column label="来源" width="110">
            <template #default="{ row }">{{ BINDING_SOURCE_LABEL[row.source] || row.source }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.status === 'ACTIVE' ? 'success' : row.status === 'PENDING' ? 'warning' : 'info'" size="small" effect="light">
                {{ BINDING_STATUS_LABEL[row.status] || row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="申请时间" min-width="150">
            <template #default="{ row }"><span class="cell-sub">{{ dt(row.createdAt) }}</span></template>
          </el-table-column>
          <template #empty><div class="pf-empty">这户还没有业主绑定</div></template>
        </el-table>
        <p class="pf-note">
          审核时请核对申请人信息与本页顶部登记的业主
          「{{ data.house.ownerName || '未登记' }} {{ data.house.ownerPhone || '' }}」是否一致。
        </p>
      </el-tab-pane>

      <el-tab-pane :label="`报事报修（${data.tickets.length}）`" name="tickets">
        <el-table :data="data.tickets" size="small" max-height="420">
          <el-table-column label="类型" width="90">
            <template #default="{ row }">{{ TICKET_TYPE_LABEL[row.type] || row.type }}</template>
          </el-table-column>
          <el-table-column label="内容" min-width="240">
            <template #default="{ row }"><span class="cell-sub">{{ row.content }}</span></template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.status === 'DONE' ? 'success' : row.status === 'PENDING' ? 'warning' : 'info'" size="small" effect="light">
                {{ TICKET_STATUS_LABEL[row.status] || row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="提交时间" min-width="150">
            <template #default="{ row }"><span class="cell-sub">{{ dt(row.createdAt) }}</span></template>
          </el-table-column>
          <template #empty><div class="pf-empty">这户没有报修记录</div></template>
        </el-table>
      </el-tab-pane>

      <el-tab-pane :label="`开票（${data.invoices.length}）`" name="invoices">
        <el-table :data="data.invoices" size="small" max-height="420">
          <el-table-column label="申请单号" min-width="180">
            <template #default="{ row }">{{ row.applicationNo }}</template>
          </el-table-column>
          <el-table-column label="抬头" min-width="160">
            <template #default="{ row }">
              <div class="cell-main">{{ row.title }}</div>
              <div class="cell-sub">{{ INVOICE_TITLE_TYPE_LABEL[row.titleType] || row.titleType }}</div>
            </template>
          </el-table-column>
          <el-table-column label="金额（元）" width="110" align="right">
            <template #default="{ row }"><span class="num money">{{ yuan(row.amount) }}</span></template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :type="invoiceStatusTag(row.status)" size="small" effect="light">
                {{ INVOICE_STATUS_LABEL[row.status] || row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="发票号" min-width="140">
            <template #default="{ row }"><span class="cell-sub">{{ row.invoiceNo || '—' }}</span></template>
          </el-table-column>
          <template #empty><div class="pf-empty">这户没有开票申请</div></template>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <el-card v-if="!loading && !data" class="nf">
      <p class="nf-title">没有找到这个房屋</p>
      <el-button type="primary" text @click="router.push('/houses')">返回房屋列表 →</el-button>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { HOUSE_TYPE_LABEL } from '../composables';
import {
  BILL_STATUS_LABEL,
  INVOICE_STATUS_LABEL,
  INVOICE_TITLE_TYPE_LABEL,
  PAYMENT_CHANNEL_LABEL,
  PAYMENT_STATUS_LABEL,
  billStatusTag,
  day,
  dt,
  invoiceStatusTag,
  paymentStatusTag,
  yuan,
} from '../finance';

/** 绑定相关文案：后台此前没有这几个映射，直接渲染会外露英文 */
const BINDING_RELATION_LABEL: Record<string, string> = { OWNER: '业主', FAMILY: '家属', TENANT: '租客' };
const BINDING_SOURCE_LABEL: Record<string, string> = { PHONE_MATCH: '手机号匹配', APPLY: '自助申请' };
const BINDING_STATUS_LABEL: Record<string, string> = { PENDING: '待审核', ACTIVE: '已通过', REJECTED: '已驳回' };
const TICKET_TYPE_LABEL: Record<string, string> = { REPAIR: '报修', COMPLAINT: '投诉', SUGGESTION: '建议' };
const TICKET_STATUS_LABEL: Record<string, string> = {
  PENDING: '待受理',
  PROCESSING: '处理中',
  DONE: '已办结',
  CLOSED: '已关闭',
};

interface Profile {
  house: {
    id: string;
    code: string;
    displayName: string;
    type: string;
    area: string | null;
    status: string;
    ownerName: string | null;
    ownerPhone: string | null;
    communityId: string | null;
    communityName: string | null;
    servicePhone: string | null;
  };
  summary: {
    unpaidAmount: string;
    unpaidCount: number;
    paidAmount: string;
    paidCount: number;
    openTickets: number;
    pendingBindings: number;
  };
  bills: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  bindings: Record<string, unknown>[];
  tickets: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
}

const route = useRoute();
const router = useRouter();
const data = ref<Profile | null>(null);
const loading = ref(false);
const tab = ref('bills');

const houseTypeText = computed(() =>
  data.value ? HOUSE_TYPE_LABEL[data.value.house.type] ?? '' : '',
);

const todoText = computed(() => {
  if (!data.value) return '';
  const parts: string[] = [];
  if (data.value.summary.pendingBindings > 0) parts.push(`${data.value.summary.pendingBindings} 条实名申请待审核`);
  if (data.value.summary.openTickets > 0) parts.push(`${data.value.summary.openTickets} 个报修待处理`);
  return `这户有待处理事项：${parts.join('，')}`;
});

function calcText(row: Record<string, unknown>): string {
  const s = (row.snapshot ?? {}) as Record<string, unknown>;
  if (s.unitPrice != null && s.area != null) return `${s.area} ㎡ × ${s.unitPrice} 元/㎡`;
  if (s.amount != null) return `每户固定 ${s.amount} 元`;
  if (s.readingDiff != null) return `用量 ${s.readingDiff} × ${s.unitPrice} 元`;
  return '—';
}

function goBills() {
  if (!data.value) return;
  void router.push({ path: '/bills', query: { houseId: data.value.house.id } });
}

/**
 * 「登记现金收款」不再直接跳收款页——收款页需要具体是哪一张账单，
 * 而房屋可能有多张待缴。这里切到账单页签，由用户选中具体那一笔。
 */
function goSettle() {
  tab.value = 'bills';
}

/** 带着这张待缴账单去收款页登记现金；label 仅供核对，校验在后端按 billId 做 */
function settleBill(row: { id: string; title: string; amount: string }) {
  if (!data.value) return;
  void router.push({
    path: '/payments',
    query: {
      billId: row.id,
      billLabel: `${data.value.house.displayName} · ${row.title} · ¥${row.amount}`,
    },
  });
}

async function load() {
  const houseId = route.params.houseId as string;
  if (!houseId) return;
  loading.value = true;
  try {
    data.value = await api<Profile>(`/admin/house-profile/${houseId}`);
  } catch {
    data.value = null;
  } finally {
    loading.value = false;
  }
}

watch(() => route.params.houseId, load);
onMounted(load);
</script>

<style scoped>
.hero {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-8);
  padding: var(--sp-4);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-sm);
  flex-wrap: wrap;
}
.hero-main {
  min-width: 220px;
}
.hero-title {
  margin: 0;
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}
.hero-meta {
  margin-top: 2px;
  font-size: var(--fs-12);
  color: var(--text-secondary);
}
.hero-owner {
  margin-top: var(--sp-2);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-13);
  color: var(--text-primary);
}
.hero-phone {
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}
.fig-sub {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}
.hero-actions {
  margin-left: auto;
  display: flex;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.todo-alert {
  margin-top: var(--sp-3);
}
.pf-tabs {
  margin-top: var(--sp-4);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-sm);
  padding: 0 var(--sp-4) var(--sp-3);
}
.pf-empty {
  padding: var(--sp-6) 0;
  text-align: center;
  font-size: var(--fs-12);
  color: var(--text-tertiary);
}
.pf-note {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-12);
  color: var(--text-secondary);
}
.nf {
  margin-top: var(--sp-4);
  text-align: center;
}
.nf-title {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-13);
  color: var(--text-secondary);
}

@media (max-width: 900px) {
  .hero-actions {
    margin-left: 0;
    width: 100%;
  }
}
</style>
