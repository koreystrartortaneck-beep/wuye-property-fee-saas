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
        <el-upload :auto-upload="false" :limit="1" :on-change="onFilePick" :on-remove="() => (file = null)">
          <el-button>选择表格文件</el-button>
        </el-upload>
      </div>
      <div class="field">
        <label>&nbsp;</label>
        <el-button type="primary" :loading="previewing" :disabled="!canPreview" @click="doPreview">
          检查表格
        </el-button>
      </div>
    </div>

    <!-- 检查结果 -->
    <template v-if="preview">
      <div class="check-bar">
        <span class="chk ok">✓ 可导入 <b class="num">{{ preview.summary.valid }}</b> 行</span>
        <span v-if="preview.summary.invalid > 0" class="chk bad">
          ✕ 有问题 <b class="num">{{ preview.summary.invalid }}</b> 行（将被跳过）
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
            <span v-if="row.valid" class="ok-text">✓ 可导入</span>
            <span v-else class="bad-text">✕ {{ row.issues.map((i: Issue) => i.message).join('；') }}</span>
          </template>
        </el-table-column>
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
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, type UploadFile } from 'element-plus';
import { uploadForm } from '../api';
import { currentMonth, useCommunities } from '../composables';
import { genRequestId } from '../finance';

interface Issue {
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
}
interface Preview {
  summary: { total: number; valid: number; invalid: number; totalAmount: string };
  rows: PreviewRow[];
}

const router = useRouter();
const { communities } = useCommunities();
const form = ref({ communityId: '', period: currentMonth() });
const file = ref<File | null>(null);
const preview = ref<Preview | null>(null);
const previewing = ref(false);
const confirming = ref(false);
const requestId = ref('');

const canPreview = computed(() => !!file.value && !!form.value.communityId && !!form.value.period);

onMounted(() => {
  // 单小区场景自动选定，少一次点击
  const stop = setInterval(() => {
    if (communities.value.length > 0) {
      if (!form.value.communityId) form.value.communityId = communities.value[0].id;
      clearInterval(stop);
    }
  }, 120);
  setTimeout(() => clearInterval(stop), 5000);
});

function onFilePick(f: UploadFile) {
  file.value = (f.raw as File) || null;
  preview.value = null;
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
    void router.push('/bill-run');
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
  URL.revokeObjectURL(a.href);
}
</script>

<style scoped>
.mb {
  margin-bottom: var(--sp-4);
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
.num {
  font-variant-numeric: tabular-nums;
}
</style>
