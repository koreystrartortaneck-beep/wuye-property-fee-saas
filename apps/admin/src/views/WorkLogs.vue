<template>
  <el-card>
    <div class="toolbar">
      <el-select v-model="filter.communityId" placeholder="选择小区" style="width: 180px" @change="reload">
        <el-option v-for="c in communities" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-select v-model="filter.category" placeholder="分类" clearable style="width: 130px" @change="reload">
        <el-option v-for="(label, val) in WORK_CATEGORY_LABEL" :key="val" :label="label" :value="val" />
      </el-select>
      <div class="spacer" />
      <el-button type="primary" :disabled="!filter.communityId" @click="openCreate">发布工作照片</el-button>
    </div>

    <el-table :data="rows" v-loading="loading">
      <el-table-column label="分类" width="100">
        <template #default="{ row }"><el-tag>{{ WORK_CATEGORY_LABEL[row.category] }}</el-tag></template>
      </el-table-column>
      <el-table-column prop="title" label="标题" min-width="130" />
      <el-table-column prop="description" label="说明" min-width="200" show-overflow-tooltip />
      <el-table-column label="照片" width="180">
        <template #default="{ row }">
          <el-image
            v-for="(img, i) in row.images || []"
            :key="i"
            :src="cloudImgUrl(img)"
            :preview-src-list="(row.images || []).map(cloudImgUrl)"
            :initial-index="i"
            fit="cover"
            preview-teleported
            style="width: 40px; height: 40px; margin-right: 4px; border-radius: 4px"
          />
        </template>
      </el-table-column>
      <el-table-column prop="staffName" label="人员" width="90" />
      <el-table-column label="时间" width="150">
        <template #default="{ row }">{{ String(row.createdAt).replace('T', ' ').slice(0, 16) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="80">
        <template #default="{ row }">
          <el-popconfirm title="删除该条？" @confirm="remove(row)">
            <template #reference><el-button size="small" type="danger">删除</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination class="pager" layout="total, prev, pager, next" :total="total" :page-size="20" :current-page="page"
      @current-change="(p: number) => { page = p; load(); }" />

    <el-dialog v-model="dialog" title="发布工作照片" width="560px">
      <el-form label-width="80px">
        <el-form-item label="分类">
          <el-select v-model="form.category">
            <el-option v-for="(label, val) in WORK_CATEGORY_LABEL" :key="val" :label="label" :value="val" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题"><el-input v-model="form.title" placeholder="如：早班消防巡检" maxlength="40" /></el-form-item>
        <el-form-item label="说明"><el-input v-model="form.description" type="textarea" :rows="3" maxlength="500" /></el-form-item>
        <el-form-item label="人员"><el-input v-model="form.staffName" placeholder="选填" style="width: 200px" /></el-form-item>
        <el-form-item label="照片">
          <el-upload
            list-type="picture-card"
            :file-list="fileList"
            :http-request="doUpload"
            :on-remove="onRemove"
            accept="image/*"
            :limit="9"
          >
            <el-icon><Plus /></el-icon>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="save">发布</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import { api, qs, uploadImage, type Page } from '../api';
import { WORK_CATEGORY_LABEL, useCloudImages, useCommunities } from '../composables';

const { cloudImgUrl, resolveCloud } = useCloudImages();

interface WorkLog {
  id: string;
  category: string;
  title: string | null;
  description: string | null;
  images: string[];
  staffName: string | null;
  createdAt: string;
}

const { communities } = useCommunities();
const filter = ref({ communityId: '', category: '' });
const rows = ref<WorkLog[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);

const dialog = ref(false);
const submitting = ref(false);
const form = ref({ category: 'INSPECTION', title: '', description: '', staffName: '' });
const images = ref<string[]>([]);
const fileList = ref<{ name: string; url: string }[]>([]);

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
    const data = await api<Page<WorkLog>>(`/admin/work-logs${qs({ ...filter.value, page: page.value, pageSize: 20 })}`);
    rows.value = data.list;
    total.value = data.total;
    await resolveCloud(rows.value.flatMap((r) => r.images || []));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  form.value = { category: 'INSPECTION', title: '', description: '', staffName: '' };
  images.value = [];
  fileList.value = [];
  dialog.value = true;
}

async function doUpload(opt: { file: File }) {
  const url = await uploadImage(opt.file);
  images.value.push(url);
  await resolveCloud([url]); // 立即解析新图的临时URL用于预览
  fileList.value.push({ name: url, url: cloudImgUrl(url) });
}

function onRemove(file: { url?: string }) {
  const idx = fileList.value.findIndex((f) => f.url === file.url);
  if (idx >= 0) {
    fileList.value.splice(idx, 1);
    images.value.splice(idx, 1);
  }
}

async function save() {
  if (images.value.length === 0) return ElMessage.warning('请至少上传一张照片');
  submitting.value = true;
  try {
    await api('/admin/work-logs', {
      method: 'POST',
      body: { communityId: filter.value.communityId, ...form.value, images: images.value },
    });
    ElMessage.success('已发布');
    dialog.value = false;
    await load();
  } finally {
    submitting.value = false;
  }
}

async function remove(row: WorkLog) {
  await api(`/admin/work-logs/${row.id}`, { method: 'DELETE' });
  ElMessage.success('已删除');
  await load();
}
</script>

<style scoped>
.toolbar { display: flex; gap: 10px; margin-bottom: 14px; align-items: center; }
.spacer { flex: 1; }
.pager { margin-top: 14px; justify-content: flex-end; }
</style>
