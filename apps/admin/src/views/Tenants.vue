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
      <el-table-column label="管理员账号" min-width="180">
        <template #default="{ row }">
          <div v-for="a in row.admins" :key="a.id" class="cell-main">
            {{ a.username }}
            <!-- 强制改密状态要可见：否则超管不知道对方到底改过没有 -->
            <el-tag v-if="a.mustChangePassword" type="warning" size="small" effect="light" class="ml">
              待首次改密
            </el-tag>
          </div>
          <span v-if="!row.admins?.length" class="cell-sub">无</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" min-width="190">
        <template #default="{ row }">
          <el-button size="small" :type="row.status === 'ACTIVE' ? 'warning' : 'success'" @click="toggle(row)">
            {{ row.status === 'ACTIVE' ? '停用' : '启用' }}
          </el-button>
          <!--
            重置密码。此前后台完全没有这个功能：管理员忘记密码时只能直连数据库改哈希，
            或者用灰度期那个后门模块的 mkadmin（能造超管、绕强口令、不写审计）。
            缺失的合法通道会长期把不安全的通道留在代码里。
          -->
          <el-button
            v-for="a in row.admins"
            :key="a.id"
            size="small"
            @click="resetPassword(row, a)"
          >
            重置密码
          </el-button>
        </template>
      </el-table-column>
          <template #empty>
        <EmptyState
          icon="🏢"
          title="还没有物业公司"
          desc="平台超管在此创建物业公司（租户）；各公司的数据相互隔离"
        />
      </template>
</el-table>

    <el-dialog v-model="dialog" title="新建租户" width="min(460px, 92vw)">
      <el-form label-width="var(--form-label-w)">
        <el-form-item label="公司名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="编码"><el-input v-model="form.code" placeholder="唯一英文标识，如 yunjing" /></el-form-item>
        <el-form-item label="联系人"><el-input v-model="form.contactName" /></el-form-item>
        <el-form-item label="联系电话"><el-input v-model="form.contactPhone" /></el-form-item>
        <el-divider>初始管理员账号</el-divider>
        <el-form-item label="管理员账号"><el-input v-model="form.adminUsername" /></el-form-item>
        <el-form-item label="管理员密码"><el-input v-model="form.adminPassword" placeholder="至少 6 位"  type="password" show-password /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">创建</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import EmptyState from '../components/EmptyState.vue';
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type Page } from '../api';

interface Tenant {
  id: string;
  name: string;
  code: string;
  contactName: string | null;
  contactPhone: string | null;
  status: string;
  /*
   * 该租户的管理员账号。重置密码需要 adminId，而列表原先只有租户本身——
   * 端点存在但界面上拿不到参数，等于没有入口。
   */
  admins?: { id: string; username: string; mustChangePassword: boolean; status: string }[];
}

const rows = ref<Tenant[]>([]);
const loading = ref(false);
/** 提交中：防止连点造成重复创建（如双击保存会生成两条同名收费标准 → 业主看到两张一样的账单） */
const saving = ref(false);
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
  if (saving.value) return;
  saving.value = true;
  try {
    const f = form.value;
    if (!f.name || !f.code || !f.adminUsername || f.adminPassword.length < 6) {
      return ElMessage.warning('请完整填写（密码至少 6 位）');
    }
    await api('/admin/tenants', { method: 'POST', body: f });
    ElMessage.success('租户已创建');
    dialog.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}

/**
 * 重置某租户管理员的密码。
 *
 * 口令由服务端随机生成、只在这一次响应里返回，所以必须让超管当场抄走——
 * 关掉弹窗就再也拿不到了。用 ElMessageBox 展示而不是 ElMessage：后者会自动消失。
 */
async function resetPassword(tenant: Tenant, admin: { id: string; username: string }) {
  try {
    await ElMessageBox.confirm(
      `将重置「${tenant.name}」的管理员账号 ${admin.username} 的密码。\n` +
        '系统会生成一个一次性口令，对方登录后必须立即修改；该账号当前全部登录会话会失效。',
      '重置密码',
      { type: 'warning', confirmButtonText: '生成新口令', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  const res = await api<{ username: string; password: string }>(
    `/admin/tenants/${tenant.id}/admins/${admin.id}/reset-password`,
    { method: 'POST' },
  );
  await ElMessageBox.alert(
    `账号：${res.username}\n一次性口令：${res.password}`,
    '请立即抄下并转交对方',
    {
      confirmButtonText: '我已记录',
      // 口令只返回一次，关掉就拿不到了，所以不允许点遮罩误关
      closeOnClickModal: false,
      closeOnPressEscape: false,
      dangerouslyUseHTMLString: false,
    },
  );
  await load();
}

async function toggle(row: Tenant) {
  // 停用物业公司 = 该公司下所有小区、账单、缴费全部停摆
  if (row.status === 'ACTIVE') {
    try {
      await ElMessageBox.confirm(
        `停用后「${row.name}」下的所有小区将无法出账、业主无法缴费。确定停用吗？`,
        '停用物业公司',
        { type: 'warning', confirmButtonText: '停用', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }
  await api(`/admin/tenants/${row.id}`, {
    method: 'PATCH',
    body: { status: row.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' },
  });
  await load();
}

onMounted(load);
</script>

<style scoped>
</style>
