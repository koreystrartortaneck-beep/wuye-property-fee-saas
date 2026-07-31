<template>
  <el-card>
    <template #header>用表格批量导入账单</template>

    <el-alert type="info" :closable="false" show-icon class="mb">
      <template #title>表格需要三列：<b>房号、金额、费用名称</b></template>
      <div class="tpl">
        <code>houseCode,amount,title</code><br />
        <code>1-101,222.50,2026年07月物业费</code><br />
        <code>1-102,180.00,2026年07月物业费</code>
      </div>
      <div class="tpl-note">
        表头也可用中文「房号,金额,费用名称」。支持 .csv 与 .xlsx。
        <el-button text type="primary" size="small" @click="downloadTemplate">下载模板</el-button>
      </div>
    </el-alert>

    <div class="pick-row">
      <div class="field" v-if="communities.length > 1">
        <label>小区</label>
        <el-select v-model="form.communityId" placeholder="请选择" style="width: 170px">
          <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </div>
      <div class="field">
        <label>账期</label>
        <el-date-picker
          v-model="form.period"
          type="month"
          value-format="YYYY-MM"
          format="YYYY 年 M 月"
          :clearable="false"
          style="width: 150px"
        />
      </div>
      <div class="field">
        <label>选择文件</label>
        <el-upload
          :auto-upload="false"
          :limit="1"
          accept=".csv,.xlsx"
          :on-change="onFilePick"
          :on-exceed="onExceed"
          :on-remove="() => (file = null)"
        >
          <el-button>选择表格文件</el-button>
        </el-upload>
      </div>
      <div class="field">
        <label>&nbsp;</label>
        <el-button type="primary" :loading="previewing" :disabled="!canPreview" @click="doPreview">
          检查表格
        </el-button>
        <span v-if="blockedReason" class="blocked">{{ blockedReason }}</span>
      </div>
    </div>

    <!-- 检查结果 -->
    <template v-if="preview">
      <div class="check-bar">
        <span class="chk ok">✓ 可导入 <b class="num">{{ preview.summary.valid }}</b> 行</span>
        <span v-if="preview.summary.invalid > 0" class="chk bad">
          ✕ 有问题 <b class="num">{{ preview.summary.invalid }}</b> 行（将被跳过）
        </span>
        <span v-if="preview.summary.needsReview" class="chk warn">
          ⚠ 需确认 <b class="num">{{ preview.summary.needsReview }}</b> 行（本期已有待缴账单）
        </span>
        <span class="chk">合计 <b class="num">¥{{ preview.summary.totalAmount }}</b></span>
      </div>

      <el-table :data="preview.rows" size="small" max-height="320" class="check-table">
        <el-table-column label="行" width="56">
          <template #default="{ row }">{{ row.rowNo }}</template>
        </el-table-column>
        <el-table-column label="房号" width="130">
          <template #default="{ row }">{{ row.houseCode }}</template>
        </el-table-column>
        <el-table-column label="费用名称" min-width="160">
          <template #default="{ row }">{{ row.title }}</template>
        </el-table-column>
        <el-table-column label="金额（元）" width="110" align="right">
          <template #default="{ row }"><span class="num">{{ row.amount }}</span></template>
        </el-table-column>
        <el-table-column label="检查结果" min-width="200">
          <template #default="{ row }">
            <!--
              warn 与 error 必须分开显示：warn 行是**可以导入**的，只是存在重复
              收款风险，需要人判断；混在一起显示成 ✕ 会让物业以为这一行被跳过了。
            -->
            <span v-if="row.issues.some((i: Issue) => (i.severity ?? 'error') === 'error')" class="bad-text">
              ✕ {{ row.issues.filter((i: Issue) => (i.severity ?? 'error') === 'error').map((i: Issue) => i.message).join('；') }}
            </span>
            <span v-else-if="row.needsReview" class="warn-text">
              ⚠ {{ row.issues.filter((i: Issue) => i.severity === 'warn').map((i: Issue) => i.message).join('；') }}
            </span>
            <span v-else class="ok-text">✓ 可导入</span>
          </template>
        </el-table-column>
              <template #empty>
          <EmptyState icon="⚠️" title="没有可导入的数据行" desc="检查 CSV 是否只有表头、分隔符是否为英文逗号、房号是否与系统一致" />
        </template>
</el-table>

      <div class="confirm-row">
        <el-button
          type="primary"
          :loading="confirming"
          :disabled="preview.summary.valid === 0"
          @click="doConfirm"
        >导入 {{ preview.summary.valid }} 行</el-button>
        <span class="note">导入后账单仍<b>不会</b>给业主看到，需到「出账」页核对并发布。</span>
      </div>
    </template>
  </el-card>
</template>

<script setup lang="ts">
import EmptyState from '../components/EmptyState.vue';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, type UploadFile } from 'element-plus';
import { uploadForm } from '../api';
import { currentMonth, useCommunities } from '../composables';
import { genRequestId } from '../finance';

interface Issue {
  severity?: 'error' | 'warn';
  code: string;
  message: string;
}
interface PreviewRow {
  rowNo: number;
  houseCode: string;
  title: string;
  amount: string;
  valid: boolean;
  issues: Issue[];
  needsReview?: boolean;
}
interface Preview {
  summary: { total: number; valid: number; invalid: number; needsReview: number; totalAmount: string };
  rows: PreviewRow[];
}

const router = useRouter();
const route = useRoute();
const { communities, loadCommunities } = useCommunities(false);
const form = ref({ communityId: '', period: currentMonth() });
const file = ref<File | null>(null);
const preview = ref<Preview | null>(null);
const previewing = ref(false);
const confirming = ref(false);
const requestId = ref('');

const canPreview = computed(() => !!file.value && !!form.value.communityId && !!form.value.period);

onMounted(async () => {
  // 直接 await 加载，替代此前的 setInterval 轮询：
  // 原写法 5 秒内没加载完就永久放弃，而单小区时选择框是隐藏的，
  // canPreview 恒为 false，「检查表格」按钮灰着且不给任何原因；
  // 组件卸载也不清 timer。
  try {
    await loadCommunities();
  } catch {
    /* 错误已由全局提示 */
  }
  // 账期可由「导入后跳转」带入，避免落地默认当月导致以为导入失败
  const q = route.query.period as string | undefined;
  if (q && /^\d{4}-\d{2}$/.test(q)) form.value.period = q;
  if (!form.value.communityId && communities.value.length > 0) {
    form.value.communityId = communities.value[0].id;
  }
});

/** 按钮不可用时说明原因，别让用户对着灰按钮猜 */
const blockedReason = computed(() => {
  if (!communities.value.length) return '还没有小区，请先到「设置 → 小区信息」创建';
  if (!form.value.communityId) return '请选择小区';
  if (!form.value.period) return '请选择账期';
  if (!file.value) return '请先选择表格文件';
  return '';
});

const MAX_MB = 5;
function onFilePick(f: UploadFile) {
  const raw = (f.raw as File) || null;
  preview.value = null;
  if (!raw) {
    file.value = null;
    return;
  }
  if (!/\.(csv|xlsx)$/i.test(raw.name)) {
    file.value = null;
    return ElMessage.warning('只支持 .csv 与 .xlsx 文件');
  }
  if (raw.size > MAX_MB * 1024 * 1024) {
    file.value = null;
    return ElMessage.warning(`文件不能超过 ${MAX_MB} MB`);
  }
  file.value = raw;
}

/** 只允许一个文件：不加提示的话选第二个会静默无反应 */
function onExceed() {
  ElMessage.warning('一次只能导入一个文件，请先移除已选文件');
}

async function doPreview() {
  if (!file.value) return;
  previewing.value = true;
  try {
    preview.value = await uploadForm<Preview>('/admin/bill-imports/preview', file.value, {
      communityId: form.value.communityId,
      period: form.value.period,
    });
    requestId.value = genRequestId('import');
  } finally {
    previewing.value = false;
  }
}

async function doConfirm() {
  if (!file.value) return;
  confirming.value = true;
  try {
    await uploadForm<{ batchId: string; status: string }>('/admin/bill-imports/confirm', file.value, {
      communityId: form.value.communityId,
      period: form.value.period,
      requestId: requestId.value,
    });
    ElMessage.success('已导入，请到「出账」页核对并发布');
    preview.value = null;
    file.value = null;
    void router.push({ path: '/bill-run', query: { period: form.value.period } });
  } finally {
    confirming.value = false;
  }
}

function downloadTemplate() {
  const csv = 'houseCode,amount,title\n1-101,222.50,物业费\n1-102,180.00,物业费\n';
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '账单导入模板.csv';
  a.click();
  // 延后回收：立即 revoke 在部分浏览器会导致下载被取消
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
</script>

<style scoped>
.blocked {
  margin-left: var(--sp-2);
  font-size: var(--fs-12);
  color: var(--warning-text);
}
.tpl {
  margin-top: var(--sp-2);
  font-size: var(--fs-12);
  line-height: 1.7;
}
.tpl code {
  background: var(--c-gray-100);
  padding: 1px 5px;
  border-radius: 4px;
}
.tpl-note {
  margin-top: var(--sp-2);
  font-size: var(--fs-12);
  color: var(--text-secondary);
}
.pick-row {
  display: flex;
  gap: var(--sp-4);
  align-items: flex-end;
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
.check-bar {
  display: flex;
  gap: var(--sp-6);
  margin: var(--sp-4) 0 var(--sp-3);
  flex-wrap: wrap;
  font-size: var(--fs-13);
}
.chk b {
  font-weight: var(--fw-semibold);
}
.chk.ok {
  color: var(--success-text);
}
.chk.bad {
  color: var(--danger-text);
}
/* 警示态：可导入但有重复收款风险，与「被跳过」的红色区分开 */
.chk.warn {
  color: var(--warning-text);
}
.check-table {
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.ok-text {
  color: var(--success-text);
  font-size: var(--fs-12);
}
.bad-text {
  color: var(--danger-text);
  font-size: var(--fs-12);
}
.warn-text {
  color: var(--warning-text);
  font-size: var(--fs-12);
  line-height: 1.5;
}
.confirm-row {
  margin-top: var(--sp-4);
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.note {
  font-size: var(--fs-12);
  color: var(--text-secondary);
}
</style>
