<template>
  <el-card class="mb">
    <template #header>
      <div class="card-head">
        <span>服务菜单</span>
        <el-button type="primary" size="small" @click="openCreate">新增服务</el-button>
      </div>
    </template>
    <el-table :data="items" v-loading="loadingItems" size="small">
      <el-table-column prop="name" label="服务名称" min-width="130" />
      <el-table-column prop="category" label="分类" width="90" />
      <el-table-column label="价格" width="130">
        <template #default="{ row }">{{ row.price }} {{ row.unit }}</template>
      </el-table-column>
      <el-table-column label="范围" width="120">
        <template #default="{ row }">{{ row.communityId ? communityName(row.communityId) : '全部小区' }}</template>
      </el-table-column>
      <el-table-column prop="description" label="说明" min-width="160" show-overflow-tooltip />
      <el-table-column label="上架" width="80">
        <template #default="{ row }">
          <el-switch :model-value="row.enabled" @change="(v: boolean) => toggle(row, v)" />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="80">
        <template #default="{ row }"><el-button size="small" @click="openEdit(row)">编辑</el-button></template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-card>
    <template #header>预约单</template>
    <div class="toolbar">
      <el-radio-group v-model="orderFilter.status" @change="loadOrders">
        <el-radio-button value="PENDING">待接单</el-radio-button>
        <el-radio-button value="ACCEPTED">已接单</el-radio-button>
        <el-radio-button value="DONE">已完成</el-radio-button>
        <el-radio-button value="">全部</el-radio-button>
      </el-radio-group>
    </div>
    <el-table :data="orders" v-loading="loadingOrders" size="small">
      <el-table-column prop="serviceName" label="服务" width="120" />
      <el-table-column label="金额" width="100">
        <template #default="{ row }">{{ row.price }} {{ row.unit }}</template>
      </el-table-column>
      <el-table-column label="房屋" min-width="130">
        <template #default="{ row }">{{ row.house?.displayName }}</template>
      </el-table-column>
      <el-table-column prop="contactName" label="联系人" width="90" />
      <el-table-column prop="contactPhone" label="电话" width="130" />
      <el-table-column label="期望上门" width="120">
        <template #default="{ row }">{{ String(row.expectDate).slice(0, 10) }}</template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="120" show-overflow-tooltip />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="ORDER_TAG[row.status]">{{ SERVICE_ORDER_STATUS_LABEL[row.status] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150">
        <template #default="{ row }">
          <el-button v-if="row.status === 'PENDING'" size="small" type="primary" @click="act(row, 'accept')">接单</el-button>
          <el-button v-if="row.status === 'ACCEPTED'" size="small" type="success" @click="act(row, 'done')">完成</el-button>
          <el-popconfirm v-if="row.status === 'PENDING' || row.status === 'ACCEPTED'" title="取消该预约？" @confirm="act(row, 'cancel')">
            <template #reference><el-button size="small">取消</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination class="pager" layout="total, prev, pager, next" :total="orderTotal" :page-size="20" :current-page="orderPage"
      @current-change="(p: number) => { orderPage = p; loadOrders(); }" />
  </el-card>

  <el-dialog v-model="dialog" :title="editing ? '编辑服务' : '新增服务'" width="480px">
    <el-form label-width="90px">
      <el-form-item label="适用范围">
        <el-select v-model="form.communityId" placeholder="全部小区" clearable :disabled="!!editing">
          <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="服务名称"><el-input v-model="form.name" maxlength="30" /></el-form-item>
      <el-form-item label="分类"><el-input v-model="form.category" placeholder="如 保洁 / 清洗" /></el-form-item>
      <el-form-item label="价格"><el-input-number v-model="form.price" :min="0" :precision="2" /></el-form-item>
      <el-form-item label="单位"><el-input v-model="form.unit" placeholder="元/次" style="width: 160px" /></el-form-item>
      <el-form-item label="说明"><el-input v-model="form.description" type="textarea" :rows="3" maxlength="500" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialog = false">取消</el-button>
      <el-button type="primary" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';
import { SERVICE_ORDER_STATUS_LABEL, useCommunities } from '../composables';

interface Item { id: string; name: string; category: string | null; price: string; unit: string; communityId: string | null; description: string | null; enabled: boolean; }
interface Order { id: string; serviceName: string; price: string; unit: string; contactName: string; contactPhone: string; expectDate: string; remark: string | null; status: string; house?: { displayName: string }; }

const ORDER_TAG: Record<string, 'warning' | 'primary' | 'success' | 'info'> = { PENDING: 'warning', ACCEPTED: 'primary', DONE: 'success', CANCELED: 'info' };

const { communities } = useCommunities();
const items = ref<Item[]>([]);
const loadingItems = ref(false);
const orders = ref<Order[]>([]);
const loadingOrders = ref(false);
const orderFilter = ref({ status: 'PENDING' });
const orderPage = ref(1);
const orderTotal = ref(0);

const dialog = ref(false);
const editing = ref<Item | null>(null);
const form = ref({ communityId: '', name: '', category: '', price: 0, unit: '元/次', description: '' });

function communityName(id: string): string {
  return communities.value.find((c) => c.id === id)?.name ?? '—';
}

async function loadItems() {
  loadingItems.value = true;
  try {
    const data = await api<Page<Item>>('/admin/service-items?pageSize=100');
    items.value = data.list;
  } finally {
    loadingItems.value = false;
  }
}

async function loadOrders() {
  loadingOrders.value = true;
  try {
    const data = await api<Page<Order>>(`/admin/service-orders${qs({ status: orderFilter.value.status, page: orderPage.value, pageSize: 20 })}`);
    orders.value = data.list;
    orderTotal.value = data.total;
  } finally {
    loadingOrders.value = false;
  }
}

function openCreate() {
  editing.value = null;
  form.value = { communityId: '', name: '', category: '', price: 0, unit: '元/次', description: '' };
  dialog.value = true;
}

function openEdit(row: Item) {
  editing.value = row;
  form.value = { communityId: row.communityId ?? '', name: row.name, category: row.category ?? '', price: Number(row.price), unit: row.unit, description: row.description ?? '' };
  dialog.value = true;
}

async function save() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写服务名称');
  if (editing.value) {
    await api(`/admin/service-items/${editing.value.id}`, { method: 'PATCH', body: { name: form.value.name, category: form.value.category, price: form.value.price, unit: form.value.unit, description: form.value.description } });
  } else {
    await api('/admin/service-items', { method: 'POST', body: { ...form.value, communityId: form.value.communityId || undefined } });
  }
  ElMessage.success('已保存');
  dialog.value = false;
  await loadItems();
}

async function toggle(row: Item, enabled: boolean) {
  await api(`/admin/service-items/${row.id}`, { method: 'PATCH', body: { enabled } });
  row.enabled = enabled;
}

async function act(row: Order, action: 'accept' | 'done' | 'cancel') {
  await api(`/admin/service-orders/${row.id}/${action}`, { method: 'POST' });
  ElMessage.success('已处理');
  await loadOrders();
}

onMounted(() => {
  loadItems();
  loadOrders();
});
</script>

<style scoped>
.mb { margin-bottom: 16px; }
.card-head { display: flex; justify-content: space-between; align-items: center; }
.toolbar { margin-bottom: 14px; }
.pager { margin-top: 14px; justify-content: flex-end; }
</style>
