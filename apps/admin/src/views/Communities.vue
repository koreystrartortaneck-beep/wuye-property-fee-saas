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
      <el-table-column label="操作" width="160">
        <template #default="{ row }">
          <el-button size="small" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" :type="row.status === 'ACTIVE' ? 'warning' : 'success'" @click="toggle(row)">
            {{ row.status === 'ACTIVE' ? '停用' : '启用' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination
      class="pager"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="pageSize"
      :current-page="page"
      @current-change="(p: number) => { page = p; load(); }"
    />

    <el-dialog v-model="dialog" :title="editing ? '编辑小区' : '新建小区'" width="420px">
      <el-form label-width="70px">
        <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="地址"><el-input v-model="form.address" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';

interface Community {
  id: string;
  name: string;
  address: string | null;
  status: string;
}

const rows = ref<Community[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const loading = ref(false);
const dialog = ref(false);
const editing = ref<Community | null>(null);
const form = ref({ name: '', address: '' });

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
  form.value = { name: '', address: '' };
  dialog.value = true;
}

function openEdit(row: Community) {
  editing.value = row;
  form.value = { name: row.name, address: row.address ?? '' };
  dialog.value = true;
}

async function save() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写名称');
  if (editing.value) {
    await api(`/admin/communities/${editing.value.id}`, { method: 'PATCH', body: form.value });
  } else {
    await api('/admin/communities', { method: 'POST', body: form.value });
  }
  ElMessage.success('已保存');
  dialog.value = false;
  await load();
}

async function toggle(row: Community) {
  await api(`/admin/communities/${row.id}`, {
    method: 'PATCH',
    body: { status: row.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' },
  });
  await load();
}

onMounted(load);
</script>

<style scoped>
.toolbar {
  margin-bottom: 14px;
}
.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
</style>
