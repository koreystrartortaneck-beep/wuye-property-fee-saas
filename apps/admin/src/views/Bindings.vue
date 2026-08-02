<template>
  <el-card>
    <div class="toolbar">
      <el-radio-group v-model="status" @change="reload">
        <el-radio-button value="PENDING">待审核</el-radio-button>
        <el-radio-button value="ACTIVE">已通过</el-radio-button>
        <el-radio-button value="REJECTED">已驳回</el-radio-button>
        <el-radio-button value="">全部</el-radio-button>
      </el-radio-group>
    </div>
    <el-table :data="rows" v-loading="loading">
      <el-table-column label="房屋" min-width="180">
        <template #default="{ row }">
            <!-- 审核绑定前常要先看这户欠不欠费、之前有谁绑过，所以房屋必须能点进档案 -->
            <HouseCell :house-id="row.houseId" :house="row.house" :sub="row.house?.code" />
          </template>
      </el-table-column>
      <el-table-column prop="applicantName" label="申请人" width="110" />
      <el-table-column label="关系" width="80">
        <template #default="{ row }">{{ BINDING_RELATION_LABEL[row.relation] }}</template>
      </el-table-column>
      <el-table-column label="手机号" width="130">
        <template #default="{ row }">{{ row.wxUser?.phone || '—' }}</template>
      </el-table-column>
      <el-table-column label="来源" width="100">
        <template #default="{ row }">{{ row.source === 'PHONE_MATCH' ? '手机号匹配' : '自助申请' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="TAG[row.status]">{{ BINDING_STATUS_LABEL[row.status] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="rejectReason" label="驳回原因" min-width="120" />
      <el-table-column label="操作" width="200">
        <template #default="{ row }">
          <template v-if="row.status === 'PENDING'">
            <el-button size="small" type="success" :loading="reviewing" @click="review(row, true)">通过</el-button>
            <el-button size="small" type="danger" @click="openReject(row)">驳回</el-button>
          </template>
          <!--
            解除绑定。此前管理端只能审核 PENDING 申请，**没有任何办法解除已生效的绑定** ——
            而租客到期、业主卖房、当初绑错房号都必然会发生，那个人会一直看得到这户的账单。
            唯一的替代是让业主自己「注销账号」，但那会连身份数据一起匿名化且不可逆。
          -->
          <el-button
            v-else-if="row.status === 'ACTIVE'"
            size="small"
            type="danger"
            plain
            @click="openRevoke(row)"
          >解除绑定</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState
          icon="✅"
          title="暂无待审核的业主申请"
          desc="业主在小程序提交房屋绑定后会出现在这里；若业主手机号已录入房屋档案，系统会自动通过"
          :action="{ label: '去核对房屋业主手机号', to: '/houses' }"
        />
      </template>
    </el-table>
    <el-pagination
      class="pager"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="20"
      :current-page="page"
      @current-change="(p: number) => { page = p; load(); }"
    />

    <el-dialog v-model="revokeDialog" title="解除绑定" width="min(460px, 92vw)">
      <el-alert type="warning" :closable="false" show-icon class="revoke-warn">
        <template #title>
          解除后该业主将立刻看不到这户的账单，也无法再为这户缴费。已产生的缴费记录不受影响。
        </template>
      </el-alert>
      <el-form label-width="var(--form-label-w)">
        <el-form-item label="房屋">
          <span>{{ revoking?.house?.code }} {{ revoking?.house?.displayName }}</span>
        </el-form-item>
        <el-form-item label="申请人"><span>{{ revoking?.applicantName || '—' }}</span></el-form-item>
        <el-form-item label="原因">
          <!-- 业主端首页会原样显示这句话，所以要求填、且提示它可见 -->
          <el-input v-model="revokeReason" type="textarea" :rows="2" placeholder="必填，业主可见，并记入审计" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="revokeDialog = false">取消</el-button>
        <el-button type="danger" :loading="revoking2" @click="doRevoke">确认解除</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="rejectDialog" title="驳回申请" width="min(420px, 92vw)">
      <el-input v-model="rejectReason" placeholder="驳回原因（业主可见）" />
      <template #footer>
        <el-button @click="rejectDialog = false">取消</el-button>
        <el-button type="danger" :loading="reviewing" @click="review(rejecting!, false)">确认驳回</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import HouseCell from '../components/HouseCell.vue';
import EmptyState from '../components/EmptyState.vue';
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { BINDING_RELATION_LABEL, BINDING_STATUS_LABEL } from '../composables';
import { api, qs, type Page } from '../api';
import { refreshBadges } from '../badges';

interface Binding {
  id: string;
  applicantName: string | null;
  relation: string;
  status: string;
  source: string;
  rejectReason: string | null;
  houseId: string;
  house?: { displayName: string; code: string };
  wxUser?: { phone: string | null };
}

const TAG: Record<string, 'warning' | 'success' | 'danger'> = { PENDING: 'warning', ACTIVE: 'success', REJECTED: 'danger' };

const status = ref('PENDING');
/** 审核中：连点会重复提交，且审核通过意味着放开他人费用可见性，必须防重 */
const reviewing = ref(false);
const rows = ref<Binding[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const rejectDialog = ref(false);
const rejectReason = ref('');
const rejecting = ref<Binding | null>(null);
const revokeDialog = ref(false);
const revokeReason = ref('');
const revoking = ref<Binding | null>(null);
/** 解除中：连点会重复提交；解除是权限撤销，和审核通过同一个等级 */
const revoking2 = ref(false);

function openRevoke(row: Binding) {
  revoking.value = row;
  revokeReason.value = '';
  revokeDialog.value = true;
}

async function doRevoke() {
  const row = revoking.value;
  if (!row || revoking2.value) return;
  if (!revokeReason.value.trim()) {
    ElMessage.warning('请填写解除原因（业主可见）');
    return;
  }
  revoking2.value = true;
  try {
    await api(`/admin/bindings/${row.id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason: revokeReason.value.trim() }),
    });
    ElMessage.success('已解除绑定');
    revokeDialog.value = false;
    load();
    refreshBadges();
  } finally {
    revoking2.value = false;
  }
}

function reload() {
  page.value = 1;
  load();
}

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<Binding>>(`/admin/bindings${qs({ status: status.value, page: page.value, pageSize: 20 })}`);
    rows.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

function openReject(row: Binding) {
  rejecting.value = row;
  rejectReason.value = '';
  rejectDialog.value = true;
}

async function review(row: Binding, approve: boolean) {
  if (reviewing.value) return;
  reviewing.value = true;
  try {
    await api(`/admin/bindings/${row.id}/review`, {
      method: 'POST',
      body: { approve, rejectReason: approve ? undefined : rejectReason.value || '未通过审核' },
    });
    ElMessage.success(approve ? '已通过' : '已驳回');
    rejectDialog.value = false;
    await load();
    // 审完立刻刷新角标，否则侧栏仍显示旧的待审数，用户会反复点回来确认
    await refreshBadges();
  } finally {
    reviewing.value = false;
  }
}

onMounted(load);
</script>

<style scoped>

/* 解除绑定的警告条：动的是权限，必须先看到后果再填原因 */
.revoke-warn {
  margin-bottom: var(--sp-3);
}
</style>
