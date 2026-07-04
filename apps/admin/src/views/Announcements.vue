<template>
  <el-card>
    <div class="toolbar">
      <el-button type="primary" @click="openCreate">发布公告</el-button>
    </div>
    <el-table :data="rows" v-loading="loading">
      <el-table-column prop="title" label="标题" min-width="160">
        <template #default="{ row }">
          <el-tag v-if="row.pinned" size="small" type="warning" class="mr">置顶</el-tag>{{ row.title }}
        </template>
      </el-table-column>
      <el-table-column label="范围" width="140">
        <template #default="{ row }">{{ row.communityId ? communityName(row.communityId) : '全部小区' }}</template>
      </el-table-column>
      <el-table-column prop="content" label="内容" min-width="220" show-overflow-tooltip />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'PUBLISHED' ? 'success' : 'info'">{{ row.status === 'PUBLISHED' ? '已发布' : '已撤回' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="发布时间" width="150">
        <template #default="{ row }">{{ String(row.publishedAt).replace('T', ' ').slice(0, 16) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="220">
        <template #default="{ row }">
          <el-button size="small" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" :type="row.pinned ? 'info' : 'warning'" @click="togglePin(row)">
            {{ row.pinned ? '取消置顶' : '置顶' }}
          </el-button>
          <el-button
            size="small"
            :type="row.status === 'PUBLISHED' ? 'danger' : 'success'"
            @click="toggleStatus(row)"
          >{{ row.status === 'PUBLISHED' ? '撤回' : '重新发布' }}</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination
      class="pager"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="20"
      :current-page="page"
      @current-change="(p: number) => { page = p; load(); }"
    />

    <el-dialog v-model="dialog" :title="editing ? '编辑公告' : '发布公告'" width="520px">
      <el-form label-width="80px">
        <el-form-item label="适用范围">
          <el-select v-model="form.communityId" placeholder="全部小区" clearable :disabled="!!editing">
            <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题"><el-input v-model="form.title" maxlength="60" show-word-limit /></el-form-item>
        <el-form-item label="内容"><el-input v-model="form.content" type="textarea" :rows="6" maxlength="5000" /></el-form-item>
        <el-form-item label="置顶"><el-switch v-model="form.pinned" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save">{{ editing ? '保存' : '发布' }}</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type Page } from '../api';
import { useCommunities } from '../composables';

interface Announcement {
  id: string;
  communityId: string | null;
  title: string;
  content: string;
  pinned: boolean;
  status: string;
  publishedAt: string;
}

const { communities } = useCommunities();
const rows = ref<Announcement[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const dialog = ref(false);
const editing = ref<Announcement | null>(null);
const form = ref({ communityId: '', title: '', content: '', pinned: false });

function communityName(id: string): string {
  return communities.value.find((c) => c.id === id)?.name ?? '—';
}

async function load() {
  loading.value = true;
  try {
    const data = await api<Page<Announcement>>(`/admin/announcements?page=${page.value}&pageSize=20`);
    rows.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  form.value = { communityId: '', title: '', content: '', pinned: false };
  dialog.value = true;
}

function openEdit(row: Announcement) {
  editing.value = row;
  form.value = { communityId: row.communityId ?? '', title: row.title, content: row.content, pinned: row.pinned };
  dialog.value = true;
}

async function save() {
  if (!form.value.title.trim() || !form.value.content.trim()) return ElMessage.warning('标题和内容必填');
  if (editing.value) {
    await api(`/admin/announcements/${editing.value.id}`, {
      method: 'PATCH',
      body: { title: form.value.title, content: form.value.content, pinned: form.value.pinned },
    });
  } else {
    await api('/admin/announcements', {
      method: 'POST',
      body: { ...form.value, communityId: form.value.communityId || undefined },
    });
  }
  ElMessage.success(editing.value ? '已保存' : '已发布');
  dialog.value = false;
  await load();
}

async function togglePin(row: Announcement) {
  await api(`/admin/announcements/${row.id}`, { method: 'PATCH', body: { pinned: !row.pinned } });
  await load();
}

async function toggleStatus(row: Announcement) {
  await api(`/admin/announcements/${row.id}`, {
    method: 'PATCH',
    body: { status: row.status === 'PUBLISHED' ? 'REVOKED' : 'PUBLISHED' },
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
.mr {
  margin-right: 6px;
}
</style>
