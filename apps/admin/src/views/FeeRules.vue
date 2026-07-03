<template>
  <el-card>
    <div class="toolbar">
      <el-select v-model="communityId" placeholder="选择小区" style="width: 180px" @change="load">
        <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <div class="spacer" />
      <el-button type="primary" :disabled="!communityId" @click="openCreate">新建规则</el-button>
    </div>

    <el-table :data="rows" v-loading="loading">
      <el-table-column prop="name" label="规则名称" min-width="130" />
      <el-table-column label="计费方式" width="110">
        <template #default="{ row }">{{ RULE_TYPE_LABEL[row.ruleType] }}</template>
      </el-table-column>
      <el-table-column label="参数" min-width="200">
        <template #default="{ row }">{{ paramText(row) }}</template>
      </el-table-column>
      <el-table-column label="适用对象" width="90">
        <template #default="{ row }">{{ HOUSE_TYPE_LABEL[row.houseType] }}</template>
      </el-table-column>
      <el-table-column label="周期" width="80">
        <template #default="{ row }">{{ PERIOD_LABEL[row.period] }}</template>
      </el-table-column>
      <el-table-column label="出账日" width="80">
        <template #default="{ row }">{{ row.billDay }} 号</template>
      </el-table-column>
      <el-table-column label="缴费期" width="80">
        <template #default="{ row }">{{ row.dueDays }} 天</template>
      </el-table-column>
      <el-table-column label="启用" width="80">
        <template #default="{ row }">
          <el-switch :model-value="row.enabled" @change="(v: boolean) => toggle(row, v)" />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90">
        <template #default="{ row }">
          <el-button size="small" @click="openEdit(row)">编辑</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="editing ? '编辑规则' : '新建规则'" width="520px">
      <el-form label-width="100px">
        <el-form-item label="规则名称"><el-input v-model="form.name" placeholder="如 物业管理费" /></el-form-item>
        <el-form-item label="计费方式">
          <el-select v-model="form.ruleType" :disabled="!!editing">
            <el-option v-for="(label, val) in RULE_TYPE_LABEL" :key="val" :label="label" :value="val" />
          </el-select>
        </el-form-item>

        <!-- 按类型动态参数 -->
        <template v-if="form.ruleType === 'AREA_PRICE'">
          <el-form-item label="单价"><el-input-number v-model="p.unitPrice" :min="0.01" :precision="2" /> 元/㎡/期</el-form-item>
        </template>
        <template v-else-if="form.ruleType === 'FIXED'">
          <el-form-item label="金额"><el-input-number v-model="p.amount" :min="0.01" :precision="2" /> 元/期</el-form-item>
        </template>
        <template v-else-if="form.ruleType === 'METER'">
          <el-form-item label="表类型">
            <el-select v-model="p.meterType">
              <el-option v-for="(label, val) in METER_LABEL" :key="val" :label="label" :value="val" />
            </el-select>
          </el-form-item>
          <el-form-item label="单价"><el-input-number v-model="p.unitPrice" :min="0.01" :precision="2" /> 元/单位用量</el-form-item>
        </template>
        <template v-else-if="form.ruleType === 'SHARE'">
          <el-form-item label="分摊方式">
            <el-radio-group v-model="p.shareBy">
              <el-radio value="AREA">按面积</el-radio>
              <el-radio value="HOUSE">按户均分</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-alert type="info" :closable="false" title="公摊类规则每期需在「公摊录入」页登记总额后才能出账" />
        </template>
        <template v-else-if="form.ruleType === 'FORMULA'">
          <el-form-item label="公式">
            <el-input v-model="p.expr" placeholder="如 area * price * 0.9（可用变量：area + 下方自定义）" />
          </el-form-item>
          <el-form-item label="自定义变量">
            <div class="vars">
              <div v-for="(v, i) in formulaVars" :key="i" class="var-row">
                <el-input v-model="v.key" placeholder="变量名" style="width: 130px" />
                <el-input-number v-model="v.value" :precision="4" style="width: 150px" />
                <el-button text type="danger" @click="formulaVars.splice(i, 1)">删除</el-button>
              </div>
              <el-button text type="primary" @click="formulaVars.push({ key: '', value: 0 })">+ 添加变量</el-button>
            </div>
          </el-form-item>
        </template>

        <el-form-item label="适用对象">
          <el-select v-model="form.houseType">
            <el-option v-for="(label, val) in HOUSE_TYPE_LABEL" :key="val" :label="label" :value="val" />
          </el-select>
        </el-form-item>
        <el-form-item label="出账周期">
          <el-select v-model="form.period">
            <el-option v-for="(label, val) in PERIOD_LABEL" :key="val" :label="label" :value="val" />
          </el-select>
        </el-form-item>
        <el-form-item label="出账日">
          <el-input-number v-model="form.billDay" :min="1" :max="28" /> 号（自动出账触发日）
        </el-form-item>
        <el-form-item label="缴费期限">
          出账后 <el-input-number v-model="form.dueDays" :min="1" :max="90" /> 天内
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';
import { HOUSE_TYPE_LABEL, METER_LABEL, PERIOD_LABEL, RULE_TYPE_LABEL, useCommunities } from '../composables';

interface FeeRule {
  id: string;
  name: string;
  ruleType: string;
  houseType: string;
  params: Record<string, unknown>;
  period: string;
  billDay: number;
  dueDays: number;
  enabled: boolean;
}

const { communities } = useCommunities();
const communityId = ref('');
const rows = ref<FeeRule[]>([]);
const loading = ref(false);
const dialog = ref(false);
const editing = ref<FeeRule | null>(null);
const form = ref({ name: '', ruleType: 'AREA_PRICE', houseType: 'RESIDENCE', period: 'MONTHLY', billDay: 1, dueDays: 15 });
const p = ref<Record<string, any>>({ unitPrice: 1, amount: 100, meterType: 'WATER', shareBy: 'AREA', expr: '' });
const formulaVars = ref<{ key: string; value: number }[]>([]);

watch(communities, (list) => {
  if (!communityId.value && list.length > 0) {
    communityId.value = list[0].id;
    load();
  }
});

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<FeeRule>>(`/admin/fee-rules${qs({ communityId: communityId.value, pageSize: 100 })}`);
    rows.value = data.list;
  } finally {
    loading.value = false;
  }
}

function paramText(row: FeeRule): string {
  const pr = row.params as Record<string, any>;
  switch (row.ruleType) {
    case 'AREA_PRICE': return `${pr.unitPrice} 元/㎡`;
    case 'FIXED': return `${pr.amount} 元/期`;
    case 'METER': return `${METER_LABEL[pr.meterType]} ${pr.unitPrice} 元/单位`;
    case 'SHARE': return pr.shareBy === 'AREA' ? '按面积分摊' : '按户均分';
    case 'FORMULA': return pr.expr;
    default: return JSON.stringify(pr);
  }
}

function buildParams(): Record<string, unknown> {
  switch (form.value.ruleType) {
    case 'AREA_PRICE': return { unitPrice: p.value.unitPrice };
    case 'FIXED': return { amount: p.value.amount };
    case 'METER': return { unitPrice: p.value.unitPrice, meterType: p.value.meterType };
    case 'SHARE': return { shareBy: p.value.shareBy };
    case 'FORMULA': {
      const vars: Record<string, number> = {};
      for (const v of formulaVars.value) if (v.key.trim()) vars[v.key.trim()] = v.value;
      return { expr: p.value.expr, vars };
    }
    default: return {};
  }
}

function openCreate() {
  editing.value = null;
  form.value = { name: '', ruleType: 'AREA_PRICE', houseType: 'RESIDENCE', period: 'MONTHLY', billDay: 1, dueDays: 15 };
  p.value = { unitPrice: 1, amount: 100, meterType: 'WATER', shareBy: 'AREA', expr: '' };
  formulaVars.value = [];
  dialog.value = true;
}

function openEdit(row: FeeRule) {
  editing.value = row;
  form.value = { name: row.name, ruleType: row.ruleType, houseType: row.houseType, period: row.period, billDay: row.billDay, dueDays: row.dueDays };
  p.value = { unitPrice: 1, amount: 100, meterType: 'WATER', shareBy: 'AREA', expr: '', ...(row.params as object) };
  formulaVars.value = Object.entries(((row.params as any).vars ?? {}) as Record<string, number>).map(([key, value]) => ({ key, value }));
  dialog.value = true;
}

async function save() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写规则名称');
  const params = buildParams();
  if (editing.value) {
    await api(`/admin/fee-rules/${editing.value.id}`, {
      method: 'PATCH',
      body: { name: form.value.name, params, billDay: form.value.billDay, dueDays: form.value.dueDays },
    });
  } else {
    await api('/admin/fee-rules', {
      method: 'POST',
      body: { ...form.value, params, communityId: communityId.value },
    });
  }
  ElMessage.success('已保存');
  dialog.value = false;
  await load();
}

async function toggle(row: FeeRule, enabled: boolean) {
  await api(`/admin/fee-rules/${row.id}`, { method: 'PATCH', body: { enabled } });
  row.enabled = enabled;
}
</script>

<style scoped>
.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
}
.spacer {
  flex: 1;
}
.vars {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.var-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
