<template>
  <el-card v-if="formulaRules.length > 0" class="mb">
    <template #header>公式规则处置（自定义公式已停用，需逐条转换或退役后方可发布上线）</template>
    <el-alert
      class="mb"
      :type="readiness.ready ? 'success' : 'warning'"
      :closable="false"
      :title="readiness.ready ? '所有公式规则已处置完毕，满足上线条件。' : `仍有 ${readiness.unresolvedFormulaRules.length} 条公式规则待处置，未满足上线条件。`"
    />
    <el-table :data="formulaRules" size="small">
      <el-table-column prop="name" label="规则名称" min-width="140" />
      <el-table-column label="小区" min-width="140">
        <template #default="{ row }">{{ communityName(row.communityId) }}</template>
      </el-table-column>
      <el-table-column label="处置状态" width="120">
        <template #default="{ row }">
          <el-tag :type="row.disposition === 'RETIRED' ? 'info' : 'warning'">
            {{ row.disposition === 'RETIRED' ? '已退役' : '待处置' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180">
        <template #default="{ row }">
          <template v-if="row.disposition !== 'RETIRED'">
            <el-button size="small" type="primary" @click="openConvert(row)">转换</el-button>
            <el-popconfirm title="退役后该公式规则永久不可再启用，确认？" @confirm="retire(row)">
              <template #reference><el-button size="small" type="danger">退役</el-button></template>
            </el-popconfirm>
          </template>
          <span v-else class="sub">已退役</span>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

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
          <el-switch
            :model-value="row.enabled"
            :disabled="row.ruleType === 'FORMULA'"
            @change="(v: boolean) => toggle(row, v)"
          />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="160">
        <template #default="{ row }">
          <template v-if="row.ruleType === 'FORMULA'">
            <el-button size="small" type="primary" @click="openConvert(row)">转换</el-button>
          </template>
          <el-button v-else size="small" @click="openEdit(row)">编辑</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="editing ? '编辑规则' : '新建规则'" width="520px">
      <el-form label-width="100px">
        <el-form-item label="规则名称"><el-input v-model="form.name" placeholder="如 物业管理费" /></el-form-item>
        <el-form-item label="计费方式">
          <el-select v-model="form.ruleType" :disabled="!!editing">
            <el-option v-for="(label, val) in CREATE_RULE_TYPE_LABEL" :key="val" :label="label" :value="val" />
          </el-select>
        </el-form-item>

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

    <!-- 公式规则转换为标准计费方式 -->
    <el-dialog v-model="convertDialog" title="转换公式规则" width="520px">
      <el-alert class="mb" type="warning" :closable="false" title="转换后规则变为标准计费方式且默认停用，公式将永久失效。" />
      <el-form label-width="100px">
        <el-form-item label="目标计费方式">
          <el-select v-model="convertForm.ruleType">
            <el-option v-for="(label, val) in CREATE_RULE_TYPE_LABEL" :key="val" :label="label" :value="val" />
          </el-select>
        </el-form-item>
        <template v-if="convertForm.ruleType === 'AREA_PRICE'">
          <el-form-item label="单价"><el-input-number v-model="cp.unitPrice" :min="0.01" :precision="2" /> 元/㎡/期</el-form-item>
        </template>
        <template v-else-if="convertForm.ruleType === 'FIXED'">
          <el-form-item label="金额"><el-input-number v-model="cp.amount" :min="0.01" :precision="2" /> 元/期</el-form-item>
        </template>
        <template v-else-if="convertForm.ruleType === 'METER'">
          <el-form-item label="表类型">
            <el-select v-model="cp.meterType">
              <el-option v-for="(label, val) in METER_LABEL" :key="val" :label="label" :value="val" />
            </el-select>
          </el-form-item>
          <el-form-item label="单价"><el-input-number v-model="cp.unitPrice" :min="0.01" :precision="2" /> 元/单位</el-form-item>
        </template>
        <template v-else-if="convertForm.ruleType === 'SHARE'">
          <el-form-item label="分摊方式">
            <el-radio-group v-model="cp.shareBy">
              <el-radio value="AREA">按面积</el-radio>
              <el-radio value="HOUSE">按户均分</el-radio>
            </el-radio-group>
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="convertDialog = false">取消</el-button>
        <el-button type="primary" :loading="converting" @click="doConvert">确认转换</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';
import { HOUSE_TYPE_LABEL, METER_LABEL, PERIOD_LABEL, RULE_TYPE_LABEL, useCommunities } from '../composables';

// 新建/转换只允许标准计费方式，FORMULA 已停用不可创建
const CREATE_RULE_TYPE_LABEL: Record<string, string> = {
  AREA_PRICE: RULE_TYPE_LABEL.AREA_PRICE,
  FIXED: RULE_TYPE_LABEL.FIXED,
  METER: RULE_TYPE_LABEL.METER,
  SHARE: RULE_TYPE_LABEL.SHARE,
};

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
interface FormulaReportItem {
  id: string;
  communityId: string;
  name: string;
  enabled: boolean;
  disposition: string;
}

const { communities } = useCommunities();
const communityId = ref('');
const rows = ref<FeeRule[]>([]);
const loading = ref(false);
const dialog = ref(false);
const editing = ref<FeeRule | null>(null);
const form = ref({ name: '', ruleType: 'AREA_PRICE', houseType: 'RESIDENCE', period: 'MONTHLY', billDay: 1, dueDays: 15 });
const p = ref<Record<string, any>>({ unitPrice: 1, amount: 100, meterType: 'WATER', shareBy: 'AREA' });

// 公式处置
const formulaRules = ref<FormulaReportItem[]>([]);
const readiness = ref<{ ready: boolean; unresolvedFormulaRules: unknown[] }>({ ready: true, unresolvedFormulaRules: [] });
const convertDialog = ref(false);
const converting = ref(false);
const convertTarget = ref<{ id: string } | null>(null);
const convertForm = ref({ ruleType: 'FIXED' });
const cp = ref<Record<string, any>>({ unitPrice: 1, amount: 100, meterType: 'WATER', shareBy: 'AREA' });

watch(communities, (list) => {
  if (!communityId.value && list.length > 0) {
    communityId.value = list[0].id;
    load();
  }
});

onMounted(loadFormulaReport);

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<FeeRule>>(`/admin/fee-rules${qs({ communityId: communityId.value, pageSize: 100 })}`);
    rows.value = data.list;
  } finally {
    loading.value = false;
  }
}

async function loadFormulaReport() {
  const [report, gate] = await Promise.all([
    api<FormulaReportItem[]>('/admin/fee-rules/formula-report'),
    api<{ ready: boolean; unresolvedFormulaRules: unknown[] }>('/admin/fee-rules/launch-readiness'),
  ]);
  formulaRules.value = report;
  readiness.value = gate;
}

function communityName(id: string): string {
  return communities.value.find((c) => c.id === id)?.name || id;
}

function paramText(row: FeeRule): string {
  const pr = row.params as Record<string, any>;
  switch (row.ruleType) {
    case 'AREA_PRICE': return `${pr.unitPrice} 元/㎡`;
    case 'FIXED': return `${pr.amount} 元/期`;
    case 'METER': return `${METER_LABEL[pr.meterType]} ${pr.unitPrice} 元/单位`;
    case 'SHARE': return pr.shareBy === 'AREA' ? '按面积分摊' : '按户均分';
    case 'FORMULA': return `${pr.expr || '公式'}（已停用）`;
    default: return JSON.stringify(pr);
  }
}

function buildParams(type: string, src: Record<string, any>): Record<string, unknown> {
  switch (type) {
    case 'AREA_PRICE': return { unitPrice: src.unitPrice };
    case 'FIXED': return { amount: src.amount };
    case 'METER': return { unitPrice: src.unitPrice, meterType: src.meterType };
    case 'SHARE': return { shareBy: src.shareBy };
    default: return {};
  }
}

function openCreate() {
  editing.value = null;
  form.value = { name: '', ruleType: 'AREA_PRICE', houseType: 'RESIDENCE', period: 'MONTHLY', billDay: 1, dueDays: 15 };
  p.value = { unitPrice: 1, amount: 100, meterType: 'WATER', shareBy: 'AREA' };
  dialog.value = true;
}

function openEdit(row: FeeRule) {
  editing.value = row;
  form.value = { name: row.name, ruleType: row.ruleType, houseType: row.houseType, period: row.period, billDay: row.billDay, dueDays: row.dueDays };
  p.value = { unitPrice: 1, amount: 100, meterType: 'WATER', shareBy: 'AREA', ...(row.params as object) };
  dialog.value = true;
}

async function save() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写规则名称');
  if (editing.value) {
    await api(`/admin/fee-rules/${editing.value.id}`, {
      method: 'PATCH',
      body: { name: form.value.name, params: buildParams(form.value.ruleType, p.value), billDay: form.value.billDay, dueDays: form.value.dueDays },
    });
  } else {
    await api('/admin/fee-rules', {
      method: 'POST',
      body: { ...form.value, params: buildParams(form.value.ruleType, p.value), communityId: communityId.value },
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

// ---- 公式处置 ----
function openConvert(row: { id: string }) {
  convertTarget.value = row;
  convertForm.value = { ruleType: 'FIXED' };
  cp.value = { unitPrice: 1, amount: 100, meterType: 'WATER', shareBy: 'AREA' };
  convertDialog.value = true;
}

async function doConvert() {
  if (!convertTarget.value) return;
  converting.value = true;
  try {
    await api(`/admin/fee-rules/${convertTarget.value.id}/convert`, {
      method: 'POST',
      body: { ruleType: convertForm.value.ruleType, params: buildParams(convertForm.value.ruleType, cp.value) },
    });
    ElMessage.success('已转换（默认停用，请核对后启用）');
    convertDialog.value = false;
    await Promise.all([load(), loadFormulaReport()]);
  } finally {
    converting.value = false;
  }
}

async function retire(row: { id: string }) {
  await api(`/admin/fee-rules/${row.id}/retire`, { method: 'POST' });
  ElMessage.success('已退役');
  await Promise.all([load(), loadFormulaReport()]);
}
</script>

<style scoped>
.mb {
  margin-bottom: 16px;
}
.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
}
.spacer {
  flex: 1;
}
.sub {
  color: #8a7f73;
  font-size: 12px;
}
</style>
