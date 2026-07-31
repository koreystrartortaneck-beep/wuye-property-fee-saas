import { onMounted, ref } from 'vue';
import { api, imgUrl as baseImgUrl, qs, type Page } from './api';

/**
 * 云存储图片解析：业主/后台上传的 cloud:// fileID 浏览器不能直接渲染，
 * 批量向后端换成临时 https URL 后展示。非 cloud:// 的走原有 imgUrl。
 */
export function useCloudImages() {
  const cloudUrls = ref<Record<string, string>>({});

  function cloudImgUrl(rel: string): string {
    if (!rel) return '';
    if (rel.startsWith('cloud://')) return cloudUrls.value[rel] || '';
    return baseImgUrl(rel);
  }

  async function resolveCloud(all: string[]) {
    const ids = [...new Set((all || []).filter((s) => s && s.startsWith('cloud://')))].filter(
      (id) => !cloudUrls.value[id],
    );
    if (!ids.length) return;
    try {
      const map = await api<Record<string, string>>('/admin/cloud-files/urls', {
        method: 'POST',
        body: { fileIds: ids },
      });
      cloudUrls.value = { ...cloudUrls.value, ...map };
    } catch {
      /* 解析失败则显示占位，不阻断 */
    }
  }

  return { cloudImgUrl, resolveCloud };
}

/** 通用小区下拉选项 */
export function useCommunities(auto = true) {
  const communities = ref<{ id: string; name: string }[]>([]);
  async function loadCommunities() {
    const data = await api<Page<{ id: string; name: string }>>(`/admin/communities${qs({ pageSize: 200 })}`);
    communities.value = data.list;
  }
  if (auto) onMounted(loadCommunities);
  return { communities, loadCommunities };
}

export const HOUSE_TYPE_LABEL: Record<string, string> = {
  RESIDENCE: '住宅',
  PARKING: '车位',
  SHOP: '商铺',
};

export const RULE_TYPE_LABEL: Record<string, string> = {
  AREA_PRICE: '单价×面积',
  FIXED: '固定金额',
  METER: '按表计量',
  SHARE: '公摊分摊',
  FORMULA: '自定义公式',
};

export const PERIOD_LABEL: Record<string, string> = {
  MONTHLY: '每月',
  QUARTERLY: '每季',
  YEARLY: '每年',
};

export const METER_LABEL: Record<string, string> = { WATER: '水表', ELEC: '电表', GAS: '燃气表' };

// BILL_STATUS_LABEL 已移除：此前是 finance.ts 的陈旧副本（缺 DRAFT/REFUNDING/REFUNDED），
// 谁误导入就会把状态显示成 undefined。请统一从 finance.ts 取。

/** 当前自然月 'YYYY-MM' */
export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------- 三期标签 ----------

export const WORK_CATEGORY_LABEL: Record<string, string> = {
  // 与 packages/shared 的 WORK_CATEGORY_CN 一致（跨端测试强制）。
  // 业主端叫「巡检」，后台叫「日常巡检」会让员工按业主说的词搜不到。
  INSPECTION: '巡检',
  CLEANING: '保洁',
  GREENING: '绿化',
  SECURITY: '安保',
  REPAIR: '维修',
  OTHER: '其他',
};

export const SERVICE_ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING: '待接单',
  ACCEPTED: '已接单',
  DONE: '已完成',
  CANCELED: '已取消',
};

export const COUPON_TYPE_LABEL: Record<string, string> = {
  // 券面本来就印「满100减10」，业主端也叫「满减」
  DISCOUNT: '满减',
  SERVICE: '服务券',
  GIFT: '礼品券',
};

/** 今天 'YYYY-MM-DD' */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
