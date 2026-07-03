<template>
  <el-card>
    <div class="toolbar">
      <el-select v-model="communityId" placeholder="选择小区" style="width: 180px" @change="load">
        <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-select v-model="meterType" style="width: 120px" @change="load">
        <el-option v-for="(label, val) in METER_LABEL" :key="val" :label="label" :value="val" />
      </el-select>
      <el-input v-model="period" placeholder="账期 YYYY-MM" style="width: 140px" @change="load" />
      <el-button @click="load">查询</el-button>
    </div>

    <el-alert
      v-if="missing.length > 0"
      type="warning"
      :closable="false"
      :title="`本期还有 ${missing.length} 户未抄表（未抄表的按表计量账单会自动跳过）`"
      class="mb"
    />

    <h4>未录房屋（行内录入）</h4>
    <el-table :data="missing" size="small" class="mb">
      <el-table-column prop="code" label="编号" width="120" />
      <el-table-column prop="displayName" label="名称" min-width="160" />
      <el-table-column label="本期读数" width="260">
        <template #default="{ row }">
          <el-input-number v-model="inputs[row.id]" :min="0" :precision="2" size="small" />
          <el-button size="small" type="primary" class="ml" @click="submit(row)">录入</el-button>
        </template>
      </el-table-column>
    </el-table>

    <h4>已录读数</h4>
    <el-table :data="readings" size="small">
      <el-table-column label="房屋" min-width="140">
        <template #default="{ row }">{{ houseName(row.houseId) }}</template>
      </el-table-column>
      <el-table-column prop="prevValue" label="上期读数" width="110" />
      <el-table-column prop="value" label="本期读数" width="110" />
      <el-table-column label="用量" width="100">
        <template #default="{ row }">{{ (Number(row.value) - Number(row.prevValue ?? 0)).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="修改" width="240">
        <template #default="{ row }">
          <el-input-number v-model="edits[row.id]" :min="0" :precision="2" size="small" :placeholder="row.value" />
          <el-button size="small" class="ml" @click="update(row)">覆盖</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api, qs } from '../api';
import { METER_LABEL, currentMonth, useCommunities } from '../composables';

interface HouseLite {
  id: string;
  code: string;
  displayName: string;
}
interface Reading {
  id: string;
  houseId: string;
  value: string;
  prevValue: string | null;
}

const { communities } = useCommunities();
const communityId = ref('');
const meterType = ref('WATER');
const period = ref(currentMonth());
const readings = ref<Reading[]>([]);
const missing = ref<HouseLite[]>([]);
const houses = ref<Map<string, string>>(new Map());
const inputs = ref<Record<string, number>>({});
const edits = ref<Record<string, number | undefined>>({});

watch(communities, (list) => {
  if (!communityId.value && list.length > 0) {
    communityId.value = list[0].id;
    load();
  }
});

function houseName(id: string): string {
  return houses.value.get(id) ?? id;
}

async function load() {
  if (!communityId.value || !/^\d{4}-\d{2}$/.test(period.value)) return;
  const data = await api<{ readings: Reading[]; missing: HouseLite[] }>(
    `/admin/meter-readings${qs({ communityId: communityId.value, period: period.value, meterType: meterType.value })}`,
  );
  readings.value = data.readings;
  missing.value = data.missing;
  // 名称映射（missing 自带；readings 里的从房产列表补）
  const map = new Map<string, string>();
  for (const h of data.missing) map.set(h.id, `${h.displayName}（${h.code}）`);
  const page = await api<{ list: { id: string; displayName: string; code: string }[] }>(
    `/admin/houses${qs({ communityId: communityId.value, pageSize: 200 })}`,
  );
  for (const h of page.list) map.set(h.id, `${h.displayName}（${h.code}）`);
  houses.value = map;
}

async function submit(row: HouseLite) {
  const value = inputs.value[row.id];
  if (value === undefined) return ElMessage.warning('请输入读数');
  await api('/admin/meter-readings', {
    method: 'POST',
    body: { houseId: row.id, meterType: meterType.value, period: period.value, value },
  });
  ElMessage.success('已录入');
  await load();
}

async function update(row: Reading) {
  const value = edits.value[row.id];
  if (value === undefined) return ElMessage.warning('请输入新读数');
  await api('/admin/meter-readings', {
    method: 'POST',
    body: { houseId: row.houseId, meterType: meterType.value, period: period.value, value },
  });
  ElMessage.success('已覆盖');
  await load();
}
</script>

<style scoped>
.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
}
.mb {
  margin-bottom: 16px;
}
.ml {
  margin-left: 8px;
}
</style>
