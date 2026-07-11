<template>
  <el-card class="mb">
    <template #header>核销优惠券</template>
    <div class="verify-row">
      <el-input v-model="verifyCode" placeholder="输入业主出示的 8 位券码" maxlength="8" style="width: 240px" @keyup.enter="find" />
      <el-button type="primary" @click="find">查验</el-button>
      <template v-if="found">
        <span class="found">{{ found.coupon.name }}
          <el-tag :type="found.status === 'UNUSED' ? 'success' : 'info'" class="ml">{{ found.status === 'UNUSED' ? '未使用' : '已核销' }}</el-tag>
        </span>
        <el-button v-if="found.status === 'UNUSED'" type="success" @click="verify">确认核销</el-button>
      </template>
    </div>
  </el-card>

  <el-card>
    <div class="toolbar">
      <el-button type="primary" @click="openCreate">发放优惠券</el-button>
      <span class="hint">物业自发券：满减抵物业费 / 服务券 / 礼品券，无需外部商家</span>
    </div>
    <el-table :data="rows" v-loading="loading">
      <el-table-column prop="name" label="券名称" min-width="150" />
      <el-table-column label="类型" width="100">
        <template #default="{ row }">{{ COUPON_TYPE_LABEL[row.type] }}</template>
      </el-table-column>
      <el-table-column label="面额" width="140">
        <template #default="{ row }">
          <span v-if="row.type === 'DISCOUNT'">满{{ row.threshold || 0 }}减{{ row.faceValue || 0 }}</span>
          <span v-else-if="row.faceValue">{{ row.faceValue }} 元</span>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="领取" width="110">
        <template #default="{ row }">{{ row.claimedQty }} / {{ row.totalQty }}</template>
      </el-table-column>
      <el-table-column label="有效期" width="200">
        <template #default="{ row }">{{ String(row.validFrom).slice(0, 10) }} ~ {{ String(row.validTo).slice(0, 10) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-switch :model-value="row.enabled" @change="(v: boolean) => toggle(row, v)" />
        </template>
      </el-table-column>
    </el-table>
    <el-pagination class="pager" layout="total, prev, pager, next" :total="total" :page-size="20" :current-page="page"
      @current-change="(p: number) => { page = p; load(); }" />

    <el-dialog v-model="dialog" title="发放优惠券" width="500px">
      <el-form label-width="90px">
        <el-form-item label="适用范围">
          <el-select v-model="form.communityId" placeholder="全部小区" clearable>
            <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="券名称"><el-input v-model="form.name" placeholder="如 物业费满100减10" maxlength="30" /></el-form-item>
        <el-form-item label="类型">
          <el-select v-model="form.type">
            <el-option v-for="(label, val) in COUPON_TYPE_LABEL" :key="val" :label="label" :value="val" />
          </el-select>
        </el-form-item>
        <template v-if="form.type === 'DISCOUNT'">
          <el-form-item label="满（门槛）"><el-input-number v-model="form.threshold" :min="0" :precision="2" /> 元</el-form-item>
          <el-form-item label="减（面额）"><el-input-number v-model="form.faceValue" :min="0" :precision="2" /> 元</el-form-item>
        </template>
        <el-form-item v-else label="面额"><el-input-number v-model="form.faceValue" :min="0" :precision="2" /> 元</el-form-item>
        <el-form-item label="说明"><el-input v-model="form.description" placeholder="使用说明" maxlength="200" /></el-form-item>
        <el-form-item label="发行总量"><el-input-number v-model="form.totalQty" :min="1" /></el-form-item>
        <el-form-item label="每人限领"><el-input-number v-model="form.perUserLimit" :min="1" /></el-form-item>
        <el-form-item label="有效期">
          <el-date-picker v-model="form.range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始" end-placeholder="结束" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save">发放</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type Page } from '../api';
import { COUPON_TYPE_LABEL, today, useCommunities } from '../composables';

interface Coupon { id: string; name: string; type: string; faceValue: string | null; threshold: string | null; totalQty: number; claimedQty: number; validFrom: string; validTo: string; enabled: boolean; }

const { communities } = useCommunities();
const rows = ref<Coupon[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const dialog = ref(false);
const form = ref({ communityId: '', name: '', type: 'DISCOUNT', faceValue: 10, threshold: 100, description: '', totalQty: 100, perUserLimit: 1, range: [today(), today()] as string[] });

const verifyCode = ref('');
const found = ref<{ id: string; status: string; coupon: { name: string } } | null>(null);

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<Coupon>>(`/admin/coupons?page=${page.value}&pageSize=20`);
    rows.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  form.value = { communityId: '', name: '', type: 'DISCOUNT', faceValue: 10, threshold: 100, description: '', totalQty: 100, perUserLimit: 1, range: [today(), today()] };
  dialog.value = true;
}

async function save() {
  const f = form.value;
  if (!f.name.trim()) return ElMessage.warning('请填写券名称');
  if (!f.range || f.range.length !== 2) return ElMessage.warning('请选择有效期');
  await api('/admin/coupons', {
    method: 'POST',
    body: {
      communityId: f.communityId || undefined,
      name: f.name, type: f.type,
      faceValue: f.faceValue, threshold: f.type === 'DISCOUNT' ? f.threshold : undefined,
      description: f.description, totalQty: f.totalQty, perUserLimit: f.perUserLimit,
      validFrom: f.range[0], validTo: f.range[1],
    },
  });
  ElMessage.success('已发放');
  dialog.value = false;
  await load();
}

async function toggle(row: Coupon, enabled: boolean) {
  await api(`/admin/coupons/${row.id}`, { method: 'PATCH', body: { enabled } });
  row.enabled = enabled;
}

async function find() {
  if (!/^[A-Za-z0-9]{8}$/.test(verifyCode.value)) return ElMessage.warning('请输入 8 位券码');
  found.value = await api(`/admin/coupons/verify/${verifyCode.value.toUpperCase()}`);
}

async function verify() {
  if (!found.value) return;
  await api(`/admin/coupons/verify/${verifyCode.value.toUpperCase()}`, { method: 'POST' });
  ElMessage.success('已核销');
  found.value = { ...found.value, status: 'USED' };
  await load();
}

onMounted(load);
</script>

<style scoped>
.mb { margin-bottom: 16px; }
.verify-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.found { font-size: 14px; }
.ml { margin-left: 6px; }
.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.hint { color: #8a7f73; font-size: 12px; }
.pager { margin-top: 14px; justify-content: flex-end; }
</style>
