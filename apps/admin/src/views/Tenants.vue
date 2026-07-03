<template>
  <el-card>
    <div class="toolbar">
      <el-button type="primary" @click="dialog = true">新建租户（物业公司）</el-button>
    </div>
    <el-table :data="rows" v-loading="loading">
      <el-table-column prop="name" label="公司名称" min-width="160" />
      <el-table-column prop="code" label="编码" width="120" />
      <el-table-column prop="contactName" label="联系人" width="110" />
      <el-table-column prop="contactPhone" label="联系电话" width="140" />
      <el-table-column prop="status" label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'">{{ row.status === 'ACTIVE' ? '启用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100">
        <template #default="{ row }">
          <el-button size="small" :type="row.status === 'ACTIVE' ? 'warning' : 'success'" @click="toggle(row)">
            {{ row.status === 'ACTIVE' ? '停用' : '启用' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" title="新建租户" width="460px">
      <el-form label-width="110px">
        <el-form-item label="公司名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="编码"><el-input v-model="form.code" placeholder="唯一英文标识，如 yunjing" /></el-form-item>
        <el-form-item label="联系人"><el-input v-model="form.contactName" /></el-form-item>
        <el-form-item label="联系电话"><el-input v-model="form.contactPhone" /></el-form-item>
        <el-divider>初始管理员账号</el-divider>
        <el-form-item label="管理员账号"><el-input v-model="form.adminUsername" /></el-form-item>
        <el-form-item label="管理员密码"><el-input v-model="form.adminPassword" placeholder="至少 6 位" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save">创建</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type Page } from '../api';

interface Tenant {
  id: string;
  name: string;
  code: string;
  contactName: string | null;
  contactPhone: string | null;
  status: string;
}

const rows = ref<Tenant[]>([]);
const loading = ref(false);
const dialog = ref(false);
const form = ref({ name: '', code: '', contactName: '', contactPhone: '', adminUsername: '', adminPassword: '' });

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<Tenant>>('/admin/tenants?pageSize=100');
    rows.value = data.list;
  } finally {
    loading.value = false;
  }
}

async function save() {
  const f = form.value;
  if (!f.name || !f.code || !f.adminUsername || f.adminPassword.length < 6) {
    return ElMessage.warning('请完整填写（密码至少 6 位）');
  }
  await api('/admin/tenants', { method: 'POST', body: f });
  ElMessage.success('租户已创建');
  dialog.value = false;
  await load();
}

async function toggle(row: Tenant) {
  await api(`/admin/tenants/${row.id}`, {
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
</style>
