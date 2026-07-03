import { onMounted, ref } from 'vue';
import { api, qs, type Page } from './api';

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

export const BILL_STATUS_LABEL: Record<string, string> = { UNPAID: '待缴', PAID: '已缴', CANCELED: '已作废' };

/** 当前自然月 'YYYY-MM' */
export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
