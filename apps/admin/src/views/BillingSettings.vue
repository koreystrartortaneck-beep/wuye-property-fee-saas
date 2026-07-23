<template>
  <el-card class="mb">
    <template #header>收款策略（分层：平台 / 租户 / 小区，越具体优先）</template>
    <el-alert
      class="mb"
      type="info"
      :closable="false"
      title="暂停收款只拦截新的缴费下单；已发起的支付回调、退款、对账仍正常处理。修改需填写原因并记入审计。"
    />

    <el-descriptions :column="2" border size="small" class="mb">
      <el-descriptions-item label="平台策略">
        <el-tag :type="policies.platform.status === 'PAUSED' ? 'danger' : 'success'">
          {{ COLLECTION_STATUS_LABEL[policies.platform.status] }}
        </el-tag>
        <span class="sub">{{ policies.platform.reason || '' }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="租户策略">
        <el-tag :type="policies.tenant.status === 'PAUSED' ? 'danger' : 'success'">
          {{ COLLECTION_STATUS_LABEL[policies.tenant.status] }}
        </el-tag>
        <span class="sub">{{ policies.tenant.reason || '' }}</span>
      </el-descriptions-item>
    </el-descriptions>

    <div class="acts">
      <el-button v-if="isSuper" @click="openEdit('platform')">调整平台策略</el-button>
      <el-button type="primary" @click="openEdit('tenant')">调整本租户策略</el-button>
    </div>
  </el-card>

  <el-card>
    <template #header>小区级收款策略</template>
    <el-table :data="communityRows" v-loading="loading" size="small">
      <el-table-column label="小区" min-width="160">
        <template #default="{ row }">{{ communityName(row.communityId) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="row.status === 'PAUSED' ? 'danger' : 'success'">
            {{ COLLECTION_STATUS_LABEL[row.status] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="原因" min-width="180">
        <template #default="{ row }">{{ row.reason || '—' }}</template>
      </el-table-column>
      <el-table-column label="恢复时间" width="150">
        <template #default="{ row }">{{ row.resumeAt ? dt(row.resumeAt) : '—' }}</template>
      </el-table-column>
      <el-table-column label="更新时间" width="150">
        <template #default="{ row }">{{ dt(row.changedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="90">
        <template #default="{ row }">
          <el-button size="small" @click="openEdit('community', row.communityId)">调整</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="acts">
      <el-select v-model="pickCommunity" placeholder="选择小区新增策略" style="width: 200px">
        <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-button :disabled="!pickCommunity" @click="openEdit('community', pickCommunity)">设置该小区策略</el-button>
    </div>

    <el-dialog v-model="dialog" :title="editTitle" width="460px">
      <el-form label-width="90px">
        <el-form-item label="收款状态">
          <el-radio-group v-model="form.status">
            <el-radio value="OPEN">正常收款</el-radio>
            <el-radio value="PAUSED">暂停收款</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="原因">
          <el-input v-model="form.reason" type="textarea" :rows="2" placeholder="必填，记入审计" />
        </el-form-item>
        <el-form-item v-if="form.status === 'PAUSED'" label="计划恢复">
          <el-date-picker v-model="form.resumeAt" type="datetime" placeholder="可选" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">确认</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import { store } from '../store';
import { useCommunities } from '../composables';
import { COLLECTION_STATUS_LABEL, dt } from '../finance';

interface PolicyView {
  status: string;
  reason?: string | null;
  changedAt?: string;
  resumeAt?: string | null;
}
interface CommunityPolicy extends PolicyView {
  communityId: string;
}
interface Policies {
  platform: PolicyView;
  tenant: PolicyView;
  communities: CommunityPolicy[];
}

const isSuper = computed(() => store.profile?.role === 'SUPER_ADMIN');
const { communities } = useCommunities();
const policies = ref<Policies>({ platform: { status: 'OPEN' }, tenant: { status: 'OPEN' }, communities: [] });
const loading = ref(false);
const pickCommunity = ref('');

const communityRows = computed(() => policies.value.communities);
const dialog = ref(false);
const submitting = ref(false);
const scope = ref<'platform' | 'tenant' | 'community'>('tenant');
const scopeCommunityId = ref('');
const form = ref<{ status: string; reason: string; resumeAt: string | null }>({ status: 'OPEN', reason: '', resumeAt: null });

const editTitle = computed(() => {
  if (scope.value === 'platform') return '调整平台收款策略';
  if (scope.value === 'tenant') return '调整本租户收款策略';
  return `调整小区收款策略 · ${communityName(scopeCommunityId.value)}`;
});

onMounted(load);

async function load() {
  loading.value = true;
  try {
    policies.value = await api<Policies>('/admin/collection-policies');
  } finally {
    loading.value = false;
  }
}

function communityName(id: string): string {
  return communities.value.find((c) => c.id === id)?.name || id;
}

function openEdit(s: 'platform' | 'tenant' | 'community', communityId = '') {
  scope.value = s;
  scopeCommunityId.value = communityId;
  const src =
    s === 'platform'
      ? policies.value.platform
      : s === 'tenant'
        ? policies.value.tenant
        : policies.value.communities.find((c) => c.communityId === communityId);
  form.value = { status: src?.status || 'OPEN', reason: '', resumeAt: null };
  dialog.value = true;
}

async function submit() {
  if (!form.value.reason.trim()) return ElMessage.warning('请填写调整原因');
  const body: Record<string, unknown> = { status: form.value.status, reason: form.value.reason.trim() };
  if (form.value.status === 'PAUSED' && form.value.resumeAt) {
    body.resumeAt = new Date(form.value.resumeAt).toISOString();
  }
  const path =
    scope.value === 'platform'
      ? '/admin/collection-policies/platform'
      : scope.value === 'tenant'
        ? '/admin/collection-policies/tenant'
        : `/admin/collection-policies/community/${scopeCommunityId.value}`;
  submitting.value = true;
  try {
    await api(path, { method: 'PUT', body });
    ElMessage.success('已更新');
    dialog.value = false;
    await load();
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.mb {
  margin-bottom: 16px;
}
.acts {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}
.sub {
  color: #8a7f73;
  font-size: 12px;
  margin-left: 8px;
}
</style>
