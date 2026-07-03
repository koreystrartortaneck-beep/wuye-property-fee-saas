<template>
  <el-card>
    <div class="toolbar">
      <el-select v-model="ruleId" placeholder="选择公摊规则" style="width: 260px" @change="load">
        <el-option v-for="r in shareRules" :key="r.id" :label="`${r.name}（${communityName(r.communityId)}）`" :value="r.id" />
      </el-select>
    </div>

    <el-form inline class="mb">
      <el-form-item label="账期">
        <el-input v-model="period" placeholder="YYYY-MM" style="width: 140px" />
      </el-form-item>
      <el-form-item label="本期总额">
        <el-input-number v-model="totalAmount" :min="0.01" :precision="2" style="width: 180px" /> 元
      </el-form-item>
      <el-button type="primary" :disabled="!ruleId" @click="save">保存（可覆盖）</el-button>
    </el-form>

    <h4>历史录入</h4>
    <el-table :data="pools" size="small">
      <el-table-column prop="period" label="账期" width="120" />
      <el-table-column prop="totalAmount" label="总额（元）" width="140" />
      <el-table-column prop="createdAt" label="录入时间" min-width="170">
        <template #default="{ row }">{{ String(row.createdAt).replace('T', ' ').slice(0, 16) }}</template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';
import { currentMonth, useCommunities } from '../composables';

interface Rule {
  id: string;
  name: string;
  communityId: string;
}
interface Pool {
  id: string;
  period: string;
  totalAmount: string;
  createdAt: string;
}

const { communities } = useCommunities();
const shareRules = ref<Rule[]>([]);
const ruleId = ref('');
const period = ref(currentMonth());
const totalAmount = ref(0);
const pools = ref<Pool[]>([]);

function communityName(id: string): string {
  return communities.value.find((c) => c.id === id)?.name ?? '';
}

onMounted(async () => {
  const data = await api<Page<Rule & { ruleType: string }>>(`/admin/fee-rules${qs({ pageSize: 200 })}`);
  shareRules.value = data.list.filter((r) => (r as { ruleType: string }).ruleType === 'SHARE');
  if (shareRules.value.length > 0) {
    ruleId.value = shareRules.value[0].id;
    await load();
  }
});

async function load() {
  if (!ruleId.value) return;
  pools.value = await api<Pool[]>(`/admin/share-pools${qs({ ruleId: ruleId.value })}`);
}

async function save() {
  if (!/^\d{4}(-\d{2}|-Q[1-4])?$/.test(period.value)) return ElMessage.warning('账期格式：YYYY-MM / YYYY-Qn / YYYY');
  if (!totalAmount.value) return ElMessage.warning('请填写总额');
  await api('/admin/share-pools', {
    method: 'PUT',
    body: { ruleId: ruleId.value, period: period.value, totalAmount: totalAmount.value },
  });
  ElMessage.success('已保存，出账时按此总额分摊');
  await load();
}
</script>

<style scoped>
.toolbar {
  margin-bottom: 14px;
}
.mb {
  margin-bottom: 8px;
}
</style>
