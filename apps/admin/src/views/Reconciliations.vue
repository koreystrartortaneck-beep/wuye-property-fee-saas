<template>
  <el-card class="mb">
    <template #header>发起对账</template>
    <!--
      商户参数不再要求手输。它们只存在于服务端环境变量里，其中「商户账户 ID」
      实际上是商户 API 证书的序列号（一串十六进制），后台没有任何地方能查到——
      于是这个功能事实上不可用。而每日定时对账本来就是从同一批环境变量读的。
      这里只显示服务端配了哪个商户（脱敏），让操作者知道会用哪套凭据。
    -->
    <el-form inline>
      <el-form-item label="对账商户">
        <span v-if="cfg?.configured" class="cell-sub">商户号 {{ cfg.mchid }} · 小程序 {{ cfg.appid }}</span>
        <span v-else class="cell-sub is-bad">服务端未配置商户参数</span>
      </el-form-item>
      <el-form-item label="账单类型">
        <el-select v-model="trigger.billType" style="width: 130px">
          <el-option v-for="(label, val) in RECON_BILL_TYPE_LABEL" :key="val" :label="label" :value="val" />
        </el-select>
      </el-form-item>
      <el-form-item label="账单日期">
        <el-date-picker v-model="trigger.businessDate" type="date" placeholder="账单日" style="width: 150px" />
      </el-form-item>
      <el-form-item label="强制重跑">
        <!--
          force 此前在界面上完全没有入口，但后端一直支持，而前端无论如何都提示
          「对账已发起」——已完成的账期实际会被幂等跳过，操作者以为重跑了。
        -->
        <el-switch v-model="trigger.force" />
      </el-form-item>
      <el-button type="primary" :loading="triggering" :disabled="!cfg?.configured" @click="doTrigger">
        对账
      </el-button>
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
      <template #empty>
        <EmptyState
          icon="⚖️"
          title="还没有对账记录"
          desc="系统每日自动拉取微信支付账单核对金额与笔数，差异会登记为运营事件"
        >
          <template #action>
            <el-button type="primary" :loading="triggering" @click="doTrigger">立即对账</el-button>
          </template>
        </EmptyState>
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

    <el-dialog v-model="itemsDialog" title="对账差异明细" width="min(720px, 92vw)">
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
              <template #empty>
          <EmptyState icon="✅" title="这次对账没有差异" desc="系统账与微信支付账单逐笔核对一致，无需处置" />
        </template>
</el-table>
    </el-dialog>

    <el-dialog v-model="resolveDialog" title="处置对账差异" width="min(440px, 92vw)">
      <el-form label-width="var(--form-label-w)">
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
import EmptyState from '../components/EmptyState.vue';
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

/** 服务端配置的对账商户（脱敏），用于显示与禁用按钮 */
const cfg = ref<{ configured: boolean; mchid: string; appid: string } | null>(null);

const trigger = ref<{ billType: string; businessDate: string; force: boolean }>({
  force: false,
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

onMounted(() => {
  // 两个请求互不依赖，任一失败不应让另一块消失
  void Promise.allSettled([load(), loadConfig()]);
});

async function loadConfig() {
  try {
    cfg.value = await api<{ configured: boolean; mchid: string; appid: string }>(
      '/admin/reconciliations/config',
    );
  } catch {
    cfg.value = { configured: false, mchid: '', appid: '' };
  }
}

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
  if (!t.businessDate) return ElMessage.warning('请选择账单日期');
  triggering.value = true;
  try {
    // 商户参数由服务端从环境变量取，与每日定时对账用的是同一套
    const res = await api<{
      runNo: string | null;
      status: string;
      differenceRecordCount: number;
      alreadyDone: boolean;
      busy: boolean;
    }>(
      '/admin/reconciliations',
      {
        method: 'POST',
        body: {
          billType: t.billType,
          businessDate: new Date(t.businessDate).toISOString(),
          force: t.force,
        },
      },
    );
    /*
     * 如实反映结果。原先无论如何都提示「对账已发起」，而已完成的账期会被幂等跳过
     * ——操作者以为重跑了，实际什么都没发生；发现差异时也不提示，还要自己去翻列表。
     */
    if (res.alreadyDone) {
      ElMessage.info('该账单日已对过账，未重复执行。需要重新核对请打开「强制重跑」。');
    } else if (res.busy) {
      ElMessage.info('该账单日正在对账中，请稍后刷新查看结果。');
    } else if (res.differenceRecordCount > 0) {
      ElMessage.warning(`对账完成，发现 ${res.differenceRecordCount} 笔差异，请在下方批次里处置`);
    } else {
      ElMessage.success('对账完成，未发现差异');
    }
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
.warn {
  color: var(--danger-text);
  font-weight: var(--fw-semibold);
}
.sub {
  color: var(--text-secondary);
  font-size: var(--fs-12);
}
</style>
