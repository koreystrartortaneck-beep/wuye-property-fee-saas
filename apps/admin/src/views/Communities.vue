<template>
  <el-card>
    <div class="toolbar">
      <el-button type="primary" @click="openCreate">新建小区</el-button>
    </div>
    <el-table :data="rows" v-loading="loading">
      <el-table-column prop="name" label="小区名称" min-width="160" />
      <el-table-column prop="address" label="地址" min-width="200" />
      <el-table-column prop="status" label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'">{{ row.status === 'ACTIVE' ? '启用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="230">
        <template #default="{ row }">
          <el-button size="small" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" :type="row.status === 'ACTIVE' ? 'warning' : 'success'" @click="toggle(row)">
            {{ row.status === 'ACTIVE' ? '停用' : '启用' }}
          </el-button>
          <!--
            删除只对「完全没有关联数据」的小区可用（后端逐项清点房屋/账单/规则/工单…，
            有任何一项就拒绝并说清挂了什么）。
            提供它的原因：历史遗留的测试小区会一直挂在首页「各小区收缴情况」表里 ——
            那张表刻意「没有账单也显示 0 而不是隐藏」，所以清理只能靠真的删掉；
            停用不够，停用后仍在表里。
          -->
          <el-button size="small" type="danger" plain @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
          <template #empty>
        <EmptyState icon="🏘" title="还没有小区" desc="小区是房屋、收费标准、账单的归属单位，先建小区才能录入房屋">
          <template #action><el-button type="primary" @click="openCreate">新建小区</el-button></template>
        </EmptyState>
      </template>
</el-table>
    <el-pagination
      class="pager"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="pageSize"
      :current-page="page"
      @current-change="(p: number) => { page = p; load(); }"
    />

    <el-dialog v-model="dialog" :title="editing ? '编辑小区' : '新建小区'" width="min(420px, 92vw)">
      <el-form label-width="var(--form-label-w)">
        <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="地址"><el-input v-model="form.address" /></el-form-item>
        <el-form-item label="管家电话"><el-input v-model="form.servicePhone" placeholder="业主端「联系管家」直拨此号" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import EmptyState from '../components/EmptyState.vue';
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, qs, type Page } from '../api';

interface Community {
  id: string;
  name: string;
  address: string | null;
  status: string;
}

const rows = ref<Community[]>([]);
const total = ref(0);
/** 提交中：防止连点造成重复创建（如双击保存会生成两条同名收费标准 → 业主看到两张一样的账单） */
const saving = ref(false);
const page = ref(1);
const pageSize = 20;
const loading = ref(false);
const dialog = ref(false);
const editing = ref<Community | null>(null);
const form = ref({ name: '', address: '', servicePhone: '' });

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<Community>>(`/admin/communities${qs({ page: page.value, pageSize })}`);
    rows.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  form.value = { name: '', address: '', servicePhone: '' };
  dialog.value = true;
}

function openEdit(row: Community) {
  editing.value = row;
  form.value = { name: row.name, address: row.address ?? '', servicePhone: (row as any).servicePhone ?? '' };
  dialog.value = true;
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    if (!form.value.name.trim()) return ElMessage.warning('请填写名称');
    if (editing.value) {
      await api(`/admin/communities/${editing.value.id}`, { method: 'PATCH', body: form.value });
    } else {
      await api('/admin/communities', { method: 'POST', body: form.value });
    }
    ElMessage.success('已保存');
    dialog.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}

async function toggle(row: Community) {
  // 停用小区会连带影响该小区的出账与业主缴费，误点代价高
  if (row.status === 'ACTIVE') {
    try {
      await ElMessageBox.confirm(
        `停用后「${row.name}」将不再参与出账，业主端也看不到该小区。确定停用吗？`,
        '停用小区',
        { type: 'warning', confirmButtonText: '停用', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }
  await api(`/admin/communities/${row.id}`, {
    method: 'PATCH',
    body: { status: row.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' },
  });
  await load();
}

async function remove(row: Community) {
  try {
    await ElMessageBox.confirm(
      `将永久删除「${row.name}」。仅当该小区下没有任何房屋、账单、收费规则等数据时才能删除；` +
        '若有数据，系统会拒绝并告知具体是什么。',
      '删除小区',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  /*
   * 后端拒绝时的 message 已经写清了「还有房屋 3 条、账单 12 条」这类原因，
   * api() 会把它 toast 出来 —— 这里不要自己再包一层「删除失败」，
   * 那会把唯一有用的信息盖掉。
   */
  await api(`/admin/communities/${row.id}`, { method: 'DELETE' });
  ElMessage.success('已删除');
  await load();
}

onMounted(load);
</script>

<style scoped>
</style>
