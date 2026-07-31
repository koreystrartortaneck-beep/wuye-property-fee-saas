<template>
  <el-card>
    <div class="toolbar">
      <el-select v-model="filter.communityId" placeholder="选择小区" style="width: 180px" @change="reload">
        <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-select v-model="filter.type" placeholder="类型" clearable style="width: 120px" @change="reload">
        <el-option v-for="(label, val) in HOUSE_TYPE_LABEL" :key="val" :label="label" :value="val" />
      </el-select>
      <el-input v-model="filter.keyword" placeholder="房号/业主/手机号" style="width: 200px" clearable @keyup.enter="reload" />
      <el-button @click="reload">查询</el-button>
      <div class="toolbar-spacer" />
      <el-button type="primary" :disabled="!filter.communityId" @click="openCreate">新增房屋</el-button>
      <el-button type="success" :disabled="!filter.communityId" @click="importDialog = true">CSV 批量导入</el-button>
    </div>

    <!--
      接电话查户是这个页面最高频的用途，档案却曾只藏在最右侧一个小文字按钮里，
      用户反馈「找了半天找不到档案在哪」。改为整行可点 + 首列显示成链接，
      并在此明说一句，让入口自解释。
    -->
    <p class="row-tip">点任意一行查看该房屋的<b>完整档案</b>：账单、缴费记录、实名绑定、报修、开票</p>

    <el-table
      :data="rows"
      v-loading="loading"
      class="clickable-rows"
      @row-click="(row: House) => $router.push(`/houses/${row.id}`)"
    >
      <el-table-column prop="code" label="编号" width="120">
        <template #default="{ row }"><span class="link-text">{{ row.code }}</span></template>
      </el-table-column>
      <el-table-column prop="displayName" label="名称" min-width="160" />
      <el-table-column label="类型" width="90">
        <template #default="{ row }">{{ HOUSE_TYPE_LABEL[row.type] }}</template>
      </el-table-column>
      <el-table-column prop="area" label="面积㎡" width="90" />
      <el-table-column prop="ownerName" label="业主" width="100" />
      <el-table-column prop="ownerPhone" label="手机号" width="130" />
      <el-table-column prop="status" label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'">{{ row.status === 'ACTIVE' ? '正常' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <!-- 行已可点，操作列只留「编辑」；必须 .stop，否则点编辑会同时跳去档案页 -->
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button size="small" type="primary" plain @click.stop="$router.push(`/houses/${row.id}`)">查档案</el-button>
          <el-button size="small" @click.stop="openEdit(row)">编辑</el-button>
        </template>
      </el-table-column>
      <!-- 原文案让用户自己去找「设置 → 小区信息」，现在按是否已有小区给出可点的下一步 -->
      <template #empty>
        <EmptyState
          v-if="communities.length === 0"
          icon="🏘"
          title="还没有小区"
          desc="房屋要挂在小区下面，先创建小区再导入房屋"
          :action="{ label: '去创建小区', to: '/communities' }"
        />
        <EmptyState
          v-else
          icon="🏠"
          title="这个小区还没有房屋"
          desc="房屋是账单、绑定、报修的载体；几十户以上建议用 CSV 一次导入"
        >
          <template #action>
            <el-button type="primary" @click="importDialog = true">CSV 批量导入</el-button>
            <el-button @click="openCreate">手动加一户</el-button>
          </template>
        </EmptyState>
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

    <!-- 新增/编辑 -->
    <el-dialog v-model="dialog" :title="editing ? '编辑房屋' : '新增房屋'" width="min(480px, 92vw)">
      <el-form label-width="var(--form-label-w)">
        <el-form-item label="类型">
          <el-select v-model="form.type" :disabled="!!editing">
            <el-option v-for="(label, val) in HOUSE_TYPE_LABEL" :key="val" :label="label" :value="val" />
          </el-select>
        </el-form-item>
        <el-form-item label="编号"><el-input v-model="form.code" :disabled="!!editing" placeholder="如 8-1-2602 / B2-118" /></el-form-item>
        <el-form-item label="显示名称"><el-input v-model="form.displayName" placeholder="如 8 栋 1 单元 2602" /></el-form-item>
        <el-form-item label="建筑面积"><el-input-number v-model="form.area" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="业主姓名"><el-input v-model="form.ownerName" /></el-form-item>
        <el-form-item label="业主手机"><el-input v-model="form.ownerPhone" placeholder="用于业主自动绑定" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- CSV 导入 -->
    <el-dialog v-model="importDialog" title="CSV 批量导入房屋" width="min(640px, 92vw)">
      <p class="hint">
        列顺序：<b>类型,编号,显示名称,面积,业主姓名,业主手机</b>（首行为表头会自动跳过；类型填 住宅/车位/商铺 或 RESIDENCE/PARKING/SHOP）
      </p>
      <el-input v-model="csvText" type="textarea" :rows="10" placeholder="类型,编号,显示名称,面积,业主姓名,业主手机
住宅,8-1-2603,8 栋 1 单元 2603,118.5,张三,13800000001
车位,B2-119,B2 层固定车位 119,,张三,13800000001" />
      <div v-if="importResult" class="import-result">
        新增 {{ importResult.created }} · 更新 {{ importResult.updated }} · 失败 {{ importResult.failed.length }}
        <div v-for="f in importResult.failed" :key="f.index" class="fail-line">第 {{ f.index + 1 }} 行：{{ f.reason }}</div>
      </div>
      <template #footer>
        <el-button @click="importDialog = false">关闭</el-button>
        <el-button type="primary" @click="doImport">导入</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import EmptyState from '../components/EmptyState.vue';
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, qs, type Page } from '../api';
import { HOUSE_TYPE_LABEL, useCommunities } from '../composables';

interface House {
  id: string;
  code: string;
  displayName: string;
  type: string;
  area: string | null;
  ownerName: string | null;
  ownerPhone: string | null;
  status: string;
}

const { communities } = useCommunities();
/**
 * 支持从 URL 带入筛选：⌘K 命令面板搜到房号后跳 /houses?keyword=xxx，
 * 若此处不读 route.query，落地就是未过滤的全量列表，等于没搜。
 */
const route = useRoute();
const filter = ref({
  communityId: '',
  type: '',
  keyword: (route.query.keyword as string) || '',
});
/** 提交中：防止连点造成重复创建（如双击保存会生成两条同名收费标准 → 业主看到两张一样的账单） */
const saving = ref(false);
const rows = ref<House[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);

const dialog = ref(false);
const editing = ref<House | null>(null);
const form = ref({ type: 'RESIDENCE', code: '', displayName: '', area: 0, ownerName: '', ownerPhone: '' });

const importDialog = ref(false);
const csvText = ref('');
const importResult = ref<{ created: number; updated: number; failed: { index: number; reason: string }[] } | null>(null);

watch(communities, (list) => {
  if (!filter.value.communityId && list.length > 0) {
    filter.value.communityId = list[0].id;
    load();
  }
});

function reload() {
  page.value = 1;
  load();
}

async function load() {
  if (!filter.value.communityId) return;
  loading.value = true;
  try {
    const data = await api<Page<House>>(
      `/admin/houses${qs({ ...filter.value, page: page.value, pageSize: 20 })}`,
    );
    rows.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  form.value = { type: 'RESIDENCE', code: '', displayName: '', area: 0, ownerName: '', ownerPhone: '' };
  dialog.value = true;
}

function openEdit(row: House) {
  editing.value = row;
  form.value = {
    type: row.type,
    code: row.code,
    displayName: row.displayName,
    area: row.area ? Number(row.area) : 0,
    ownerName: row.ownerName ?? '',
    ownerPhone: row.ownerPhone ?? '',
  };
  dialog.value = true;
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    if (editing.value) {
      await api(`/admin/houses/${editing.value.id}`, {
        method: 'PATCH',
        body: {
          displayName: form.value.displayName,
          area: form.value.area || undefined,
          ownerName: form.value.ownerName,
          ownerPhone: form.value.ownerPhone,
        },
      });
    } else {
      // 单条新增复用 import（唯一键 upsert）
      const row = {
        type: form.value.type,
        code: form.value.code.trim(),
        displayName: form.value.displayName.trim(),
        area: form.value.area || undefined,
        ownerName: form.value.ownerName || undefined,
        ownerPhone: form.value.ownerPhone || undefined,
      };
      if (!row.code || !row.displayName) return ElMessage.warning('编号与显示名称必填');
      const res = await api<{ created: number; failed: { reason: string }[] }>('/admin/houses/import', {
        method: 'POST',
        body: { communityId: filter.value.communityId, rows: [row] },
      });
      if (res.failed.length > 0) return ElMessage.error(res.failed[0].reason);
    }
    ElMessage.success('已保存');
    dialog.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}

const TYPE_ALIAS: Record<string, string> = { 住宅: 'RESIDENCE', 车位: 'PARKING', 商铺: 'SHOP' };

async function doImport() {
  const lines = csvText.value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return ElMessage.warning('请粘贴 CSV 内容');
  const rowsCsv = [] as Record<string, unknown>[];
  for (const line of lines) {
    const cols = line.split(/[,，]/).map((c) => c.trim());
    if (cols[0] === '类型' || cols[0].toLowerCase() === 'type') continue; // 表头
    rowsCsv.push({
      type: TYPE_ALIAS[cols[0]] ?? cols[0],
      code: cols[1],
      displayName: cols[2],
      area: cols[3] ? Number(cols[3]) : undefined,
      ownerName: cols[4] || undefined,
      ownerPhone: cols[5] || undefined,
    });
  }
  importResult.value = await api('/admin/houses/import', {
    method: 'POST',
    body: { communityId: filter.value.communityId, rows: rowsCsv },
  });
  await load();
}
</script>

<style scoped>
.row-tip b {
  color: var(--text-secondary);
  font-weight: var(--fw-semibold);
}
/* 整行可点：给出光标与悬停反馈，否则用户不知道能点 */
.clickable-rows :deep(.el-table__row) {
  cursor: pointer;
}
.import-result {
  margin-top: 10px;
  font-size: var(--fs-13);
}
.fail-line {
  color: var(--danger-text);
}
</style>
