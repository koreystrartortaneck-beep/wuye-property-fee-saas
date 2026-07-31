<template>
  <el-card>
    <!--
      通知发不出去是「静默失效」的典型：账单照样发布、业主什么也收不到，
      只有逐条翻「失败原因」才能发现是模板 ID 没配。这里直接顶到页面最上面。
    -->
    <el-alert
      v-if="templateMissing"
      class="mb"
      type="warning"
      :closable="false"
      show-icon
      title="业主收不到通知：订阅消息模板未配置"
    >
      <template #default>
        当前有 {{ templateMissing }} 条通知因为缺少模板 ID 而发送失败。到微信公众平台
        「功能 → 订阅消息」选用模板，把模板 ID 填到云托管环境变量
        WX_TMPL_BILL_CREATED / WX_TMPL_DUE_SOON / WX_TMPL_OVERDUE，
        并同步填入小程序 config.js 的 subscribeTmplIds。
      </template>
    </el-alert>

    <div class="toolbar">
      <el-select v-model="type" placeholder="通知类型" clearable style="width: 160px" @change="reload">
        <el-option label="出账通知" value="BILL_CREATED" />
        <el-option label="到期提醒" value="DUE_SOON" />
        <el-option label="逾期提醒" value="OVERDUE" />
      </el-select>
      <el-button @click="reload">查询</el-button>
    </div>
    <el-table :data="rows" v-loading="loading" size="small">
      <!--
        房号列。这个列表原先不显示房屋，物业处理时无从判断是哪户的哪笔费用
        ——而单号/抬头都对不上房号。走 HouseCell 可点直达业主档案。
      -->
      <el-table-column label="房屋 / 费用" min-width="180">
        <template #default="{ row }">
          <HouseCell
            :house-id="row.bill?.house?.id ?? null"
            :text="row.bill?.house?.displayName || '—'"
            :sub="row.bill?.title"
          />
        </template>
      </el-table-column>
      <el-table-column label="类型" width="110">
        <template #default="{ row }">{{ TYPE[row.type] }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'SENT' ? 'success' : row.status === 'FAILED' ? 'danger' : 'info'">
            {{ STATUS[row.status] }}
          </el-tag>
        </template>
      </el-table-column>
      <!-- NOTIFY_CHANNEL_LABEL 早就导入了却没用上，界面一直显示英文枚举 WX_SUBSCRIBE / MOCK -->
      <el-table-column label="通道" width="130">
        <template #default="{ row }">{{ NOTIFY_CHANNEL_LABEL[row.channel] || row.channel }}</template>
      </el-table-column>
      <el-table-column label="失败原因" min-width="260">
        <template #default="{ row }">
          <span v-if="row.error" class="fail-reason">{{ row.error }}</span>
          <span v-else class="cell-sub">—</span>
        </template>
      </el-table-column>
      <el-table-column label="时间" width="160">
        <template #default="{ row }">{{ dt(row.sentAt) }}</template>
      </el-table-column>
          <template #empty>
        <EmptyState
          icon="🔔"
          title="还没有通知记录"
          desc="账单发布、催缴、工单进展等发给业主的通知都会记录在此，可查看送达结果"
          :action="{ label: '去发布账单', to: '/bill-run' }"
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
</template>

<script setup lang="ts">
import EmptyState from '../components/EmptyState.vue';
import { onMounted, ref } from 'vue';
import { api, qs, type Page } from '../api';
import HouseCell from '../components/HouseCell.vue';
import { NOTIFY_CHANNEL_LABEL, dt } from '../finance';

interface Log {
  /*
   * 房屋与费用名称。后端在列表里带出来（NotifyLog 因为没有到 Bill 的 Prisma 关系，
   * 是按当页 billId 去重后一次批量补的），前端据此显示可点的房号列——
   * 原先这些列表只有内部单号，物业无从判断是哪户的哪笔费用。
   */
  bill?: { title: string; period: string; house: { id: string; code: string; displayName: string } | null } | null;

  id: string;
  type: string;
  status: string;
  channel: string;
  billId: string | null;
  error: string | null;
  sentAt: string;
}

const TYPE: Record<string, string> = { BILL_CREATED: '出账通知', DUE_SOON: '到期提醒', OVERDUE: '逾期提醒' };
const STATUS: Record<string, string> = { SENT: '已发送', FAILED: '失败', SKIPPED: '跳过' };

const type = ref('');
const rows = ref<Log[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);

function reload() {
  page.value = 1;
  load();
}

/** 本页中因「未配置模板」而失败的条数；>0 时顶部给出配置指引 */
const templateMissing = ref(0);

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<Log>>(`/admin/notify-logs${qs({ type: type.value, page: page.value, pageSize: 20 })}`);
    rows.value = data.list;
    total.value = data.total;
    templateMissing.value = data.list.filter(
      (r) => r.status === 'FAILED' && (r.error ?? '').includes('未配置模板'),
    ).length;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.fail-reason {
  color: var(--danger-text);
  font-size: var(--fs-12);
  line-height: var(--lh-tight);
}
</style>
