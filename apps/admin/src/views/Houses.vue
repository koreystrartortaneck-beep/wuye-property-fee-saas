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
      <el-button :disabled="selectedHouses.length === 0" @click="openBulkAttach">
        批量挂标准{{ selectedHouses.length ? `（${selectedHouses.length} 套）` : '' }}
      </el-button>
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
      @selection-change="(sel: House[]) => (selectedHouses = sel)"
    >
      <el-table-column type="selection" width="40" />
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
      <el-table-column label="放户日期" width="110">
        <template #default="{ row }">{{ row.handoverDate ? String(row.handoverDate).slice(0, 10) : '—' }}</template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'">{{ row.status === 'ACTIVE' ? '正常' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <!-- 行已可点，操作列只留「编辑」；必须 .stop，否则点编辑会同时跳去档案页 -->
      <el-table-column label="操作" width="330" fixed="right">
        <template #default="{ row }">
          <el-button size="small" type="primary" plain @click.stop="$router.push(`/houses/${row.id}`)">查档案</el-button>
          <el-button size="small" @click.stop="openEdit(row)">编辑</el-button>
          <!-- 换租的主操作面:删旧号+加新号,删号即时解绑 -->
          <el-button size="small" @click.stop="openContacts(row)">联系人</el-button>
          <el-button size="small" @click.stop="openStandards(row)">标准</el-button>
          <!--
            导错一批房屋之后原本没有退路：只能停用，而停用的语义是
            「这套房还在，只是暂时不收费」—— 错误数据于是永久留在库里，
            还会挡住删小区（删小区要求下面没有房屋）。
          -->
          <el-button size="small" type="danger" plain @click.stop="remove(row)">删除</el-button>
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
        <el-form-item label="放户日期">
          <el-date-picker v-model="form.handoverDate" type="date" value-format="YYYY-MM-DD" placeholder="按户周年收费的起算日" />
          <div class="hint">按户周年出账以此为锚：3/15 放户 → 每年 3/15 出下一年度账单</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- CSV 导入 -->
    <el-dialog v-model="importDialog" title="CSV 批量导入房屋" width="min(640px, 92vw)">
      <p class="hint">
        列顺序：<b>类型,编号,显示名称,面积,业主姓名,业主手机,放户日期,联系人手机,标准代号</b>
        （后三列可空；首行表头自动跳过；类型填 住宅/车位/商铺；放户日期 YYYY-MM-DD；
        多个联系人手机/标准代号用分号隔开）
      </p>
      <el-input v-model="csvText" type="textarea" :rows="10" placeholder="类型,编号,显示名称,面积,业主姓名,业主手机,放户日期,联系人手机,标准代号
住宅,8-1-2603,8 栋 1 单元 2603,118.5,张三,13800000001,2019-03-15,13800000002;13800000003,WYF-ZZ
车位,B2-119,B2 层固定车位 119,,张三,13800000001,2019-03-15,,CKF" />
      <div v-if="importResult" class="import-result">
        新增 {{ importResult.created }} · 更新 {{ importResult.updated }} · 失败 {{ importResult.failed.length }}
        <template v-if="importResult.contacts">
          · 联系人 {{ importResult.contacts.added }}<template v-if="importResult.contacts.invalidPhones">（{{ importResult.contacts.invalidPhones }} 个号码格式不对被跳过）</template>
        </template>
        <template v-if="importResult.standards"> · 挂标准 {{ importResult.standards.attached }}</template>
        <div v-for="f in importResult.failed" :key="f.index" class="fail-line">第 {{ f.index + 1 }} 行：{{ f.reason }}</div>
      </div>
      <template #footer>
        <el-button @click="importDialog = false">关闭</el-button>
        <el-button type="primary" @click="doImport">导入</el-button>
      </template>
    </el-dialog>
    <!-- 授权手机号(联系人):换租 = 删旧号 + 加新号,删号即时解绑 -->
    <el-dialog v-model="contactsDialog" :title="`授权手机号 · ${contactsHouse?.displayName ?? ''}`" width="min(560px, 92vw)">
      <p class="hint">加号 = 这个人授权手机号后立刻看到本房账单；删号 = 立即看不到（同时解除绑定）。</p>
      <el-table :data="contacts" size="small" v-loading="contactsLoading">
        <el-table-column prop="phone" label="手机号" width="140" />
        <el-table-column prop="name" label="备注姓名" min-width="100">
          <template #default="{ row }">{{ row.name || '—' }}</template>
        </el-table-column>
        <el-table-column label="使用状态" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.bound" type="success" size="small">已绑定</el-tag>
            <span v-else class="hint">未使用</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="80">
          <template #default="{ row }">
            <el-button size="small" type="danger" plain @click="removeContact(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyState icon="📱" title="还没有授权任何手机号" desc="在下方添加手机号；对方授权手机号后即可看到本房账单" />
        </template>
      </el-table>
      <div class="contact-add">
        <el-input v-model="newContact.phone" placeholder="11 位手机号" style="width: 170px" />
        <el-input v-model="newContact.name" placeholder="备注姓名（选填）" style="width: 150px" />
        <el-button type="primary" :loading="contactSaving" @click="addContact">添加</el-button>
      </div>
    </el-dialog>

    <!-- 房屋挂接的收费标准:挂了才出账,不挂 = 不出账(免收) -->
    <el-dialog v-model="standardsDialog" :title="`收费标准 · ${standardsHouse?.displayName ?? ''}`" width="min(560px, 92vw)">
      <el-table :data="houseStandards" size="small" v-loading="standardsLoading">
        <el-table-column label="标准" min-width="150">
          <template #default="{ row }">{{ row.rule?.name }}<span v-if="row.rule?.code" class="hint">（{{ row.rule.code }}）</span></template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'" size="small">{{ row.status === 'ACTIVE' ? '生效' : '已摘除' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="80">
          <template #default="{ row }">
            <el-button v-if="row.status === 'ACTIVE'" size="small" type="danger" plain @click="detachStandard(row)">摘除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyState icon="📐" title="没有挂接任何收费标准" desc="不挂 = 不出账（免收/空置就是这个状态）；在下方选一条挂上即可参与出账" />
        </template>
      </el-table>
      <div class="contact-add">
        <el-select v-model="attachRuleId" placeholder="选择要挂的标准" style="width: 260px">
          <el-option v-for="r in annivRules" :key="r.id" :label="r.code ? `${r.name}（${r.code}）` : r.name" :value="r.id" />
        </el-select>
        <el-button type="primary" :loading="standardSaving" @click="attachStandard">挂上</el-button>
      </div>
    </el-dialog>

    <!-- 批量挂标准:导入 555 套之后逐套点是不可能的 -->
    <el-dialog v-model="bulkDialog" :title="`批量挂标准（已选 ${selectedHouses.length} 套）`" width="min(460px, 92vw)">
      <el-form label-width="var(--form-label-w)">
        <el-form-item label="收费标准">
          <el-select v-model="bulkRuleId" placeholder="选择标准" style="width: 260px">
            <el-option v-for="r in annivRules" :key="r.id" :label="r.code ? `${r.name}（${r.code}）` : r.name" :value="r.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bulkDialog = false">取消</el-button>
        <el-button type="primary" :loading="bulkSaving" :disabled="!bulkRuleId" @click="doBulkAttach">挂上</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import EmptyState from '../components/EmptyState.vue';
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
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
  handoverDate: string | null;
  status: string;
}

interface Contact { id: string; phone: string; name: string | null; source: string; bound: boolean }
interface HouseStandardRow { id: string; ruleId: string; status: string; rule: { name: string; code: string | null } }
interface AnnivRule { id: string; name: string; code: string | null; periodScheme: string }

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
const form = ref({ type: 'RESIDENCE', code: '', displayName: '', area: 0, ownerName: '', ownerPhone: '', handoverDate: '' });

/* ── 授权手机号(联系人) ── */
const contactsDialog = ref(false);
const contactsHouse = ref<House | null>(null);
const contacts = ref<Contact[]>([]);
const contactsLoading = ref(false);
const contactSaving = ref(false);
const newContact = ref({ phone: '', name: '' });

/* ── 收费标准挂接 ── */
const standardsDialog = ref(false);
const standardsHouse = ref<House | null>(null);
const houseStandards = ref<HouseStandardRow[]>([]);
const standardsLoading = ref(false);
const standardSaving = ref(false);
const attachRuleId = ref('');
const annivRules = ref<AnnivRule[]>([]);

/* ── 批量挂标准 ── */
const selectedHouses = ref<House[]>([]);
const bulkDialog = ref(false);
const bulkRuleId = ref('');
const bulkSaving = ref(false);

const importDialog = ref(false);
const csvText = ref('');
const importResult = ref<{
  created: number;
  updated: number;
  failed: { index: number; reason: string }[];
  contacts?: { added: number; activatedBindings: number; invalidPhones: number };
  standards?: { attached: number };
} | null>(null);

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
  form.value = { type: 'RESIDENCE', code: '', displayName: '', area: 0, ownerName: '', ownerPhone: '', handoverDate: '' };
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
    handoverDate: row.handoverDate ? String(row.handoverDate).slice(0, 10) : '',
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
          ...(form.value.handoverDate ? { handoverDate: form.value.handoverDate } : {}),
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
        handoverDate: form.value.handoverDate || undefined,
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
      handoverDate: cols[6] || undefined,
      contactPhones: cols[7] || undefined,
      standardCodes: cols[8] || undefined,
    });
  }
  importResult.value = await api('/admin/houses/import', {
    method: 'POST',
    body: { communityId: filter.value.communityId, rows: rowsCsv },
  });
  await load();
}
async function remove(row: House) {
  try {
    await ElMessageBox.confirm(
      `将永久删除「${row.displayName}」（${row.code}）。仅当这套房屋下没有账单、业主绑定、` +
        '工单等数据时才能删除；若有，系统会拒绝并告知具体是什么。',
      '删除房屋',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  /*
   * 后端拒绝时的 message 已经写清了「还有账单 3 条、业主绑定 1 条」，
   * api() 会把它 toast 出来 —— 这里不要再包一层「删除失败」盖掉它。
   */
  await api(`/admin/houses/${row.id}`, { method: 'DELETE' });
  ElMessage.success('已删除');
  await load();
}

/* ───────────── 授权手机号(联系人) ───────────── */

async function openContacts(row: House) {
  contactsHouse.value = row;
  contactsDialog.value = true;
  await loadContacts();
}

async function loadContacts() {
  if (!contactsHouse.value) return;
  contactsLoading.value = true;
  try {
    const r = await api<{ items: Contact[] }>(`/admin/houses/${contactsHouse.value.id}/contacts`);
    contacts.value = r.items;
  } finally {
    contactsLoading.value = false;
  }
}

async function addContact() {
  if (!contactsHouse.value) return;
  if (!/^1[3-9]\d{9}$/.test(newContact.value.phone.trim())) {
    return ElMessage.warning('请填写 11 位大陆手机号');
  }
  contactSaving.value = true;
  try {
    const r = await api<{ activatedBindings: number }>(`/admin/houses/${contactsHouse.value.id}/contacts`, {
      method: 'POST',
      body: { phone: newContact.value.phone.trim(), name: newContact.value.name.trim() || undefined },
    });
    ElMessage.success(r.activatedBindings > 0 ? '已添加，对方已立即绑定本房' : '已添加，对方授权手机号后即可看到账单');
    newContact.value = { phone: '', name: '' };
    await loadContacts();
  } finally {
    contactSaving.value = false;
  }
}

async function removeContact(row: Contact) {
  if (!contactsHouse.value) return;
  /*
   * 不做删前确认弹窗(产品决策),但结果必须说出来:
   * 后端如实返回本次解除了谁的绑定,这里如实展示。
   */
  const r = await api<{ revokedBindings: { wxUserId: string }[] }>(`/admin/house-contacts/${row.id}`, {
    method: 'DELETE',
  });
  ElMessage.success(
    r.revokedBindings.length > 0 ? `已删除，并同时解除了 ${r.revokedBindings.length} 人的绑定` : '已删除',
  );
  await loadContacts();
}

/* ───────────── 收费标准挂接 ───────────── */

async function loadAnnivRules() {
  if (!filter.value.communityId) return;
  const data = await api<Page<AnnivRule>>(`/admin/fee-rules${qs({ communityId: filter.value.communityId, pageSize: 100 })}`);
  // 只列周年标准:legacy 规则按房屋类型自动匹配,不走挂接
  annivRules.value = data.list.filter((r) => r.periodScheme === 'ANNIVERSARY');
}

async function openStandards(row: House) {
  standardsHouse.value = row;
  standardsDialog.value = true;
  standardsLoading.value = true;
  try {
    const [r] = await Promise.all([
      api<{ items: HouseStandardRow[] }>(`/admin/houses/${row.id}/standards`),
      loadAnnivRules(),
    ]);
    houseStandards.value = r.items;
  } finally {
    standardsLoading.value = false;
  }
}

async function attachStandard() {
  if (!standardsHouse.value || !attachRuleId.value) return;
  standardSaving.value = true;
  try {
    await api(`/admin/houses/${standardsHouse.value.id}/standards`, {
      method: 'POST',
      body: { ruleId: attachRuleId.value },
    });
    ElMessage.success('已挂上，下次出账生效');
    attachRuleId.value = '';
    const r = await api<{ items: HouseStandardRow[] }>(`/admin/houses/${standardsHouse.value.id}/standards`);
    houseStandards.value = r.items;
  } finally {
    standardSaving.value = false;
  }
}

async function detachStandard(row: HouseStandardRow) {
  if (!standardsHouse.value) return;
  await api(`/admin/houses/${standardsHouse.value.id}/standards/${row.ruleId}`, { method: 'DELETE' });
  ElMessage.success('已摘除，之后的账期不再出账（历史账单保留）');
  const r = await api<{ items: HouseStandardRow[] }>(`/admin/houses/${standardsHouse.value.id}/standards`);
  houseStandards.value = r.items;
}

/* ───────────── 批量挂标准 ───────────── */

async function openBulkAttach() {
  await loadAnnivRules();
  if (annivRules.value.length === 0) {
    return ElMessage.warning('该小区还没有「按户周年」的收费标准，请先到收费标准页新建');
  }
  bulkDialog.value = true;
}

async function doBulkAttach() {
  bulkSaving.value = true;
  try {
    const r = await api<{ attached: number; alreadyAttached: number; invalidHouseIds: string[] }>(
      '/admin/house-standards/bulk',
      {
        method: 'POST',
        body: {
          communityId: filter.value.communityId,
          ruleId: bulkRuleId.value,
          houseIds: selectedHouses.value.map((h) => h.id),
        },
      },
    );
    let msg = `已挂 ${r.attached} 套`;
    if (r.alreadyAttached) msg += `，${r.alreadyAttached} 套此前已挂`;
    if (r.invalidHouseIds.length) msg += `，${r.invalidHouseIds.length} 套不属于该小区被跳过`;
    ElMessage.success(msg);
    bulkDialog.value = false;
    bulkRuleId.value = '';
  } finally {
    bulkSaving.value = false;
  }
}
</script>

<style scoped>
.contact-add {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
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
