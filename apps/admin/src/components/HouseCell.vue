<template>
  <button
    class="house-link"
    :disabled="!houseId"
    :title="houseId ? '打开业主档案' : undefined"
    @click.stop="open"
  >
    <span class="cell-main">{{ mainText }}</span>
  </button>
  <div v-if="sub" class="cell-sub">{{ sub }}</div>
</template>

<script setup lang="ts">
/**
 * 表格里的「房屋」单元格，点击直达业主档案。
 *
 * 房屋是后台所有单据的交汇点：一条绑定申请、一张工单、一个访客码，
 * 处理时都要先回答「这户是谁、欠不欠费、之前有没有别人绑过」。
 * 改版前这些页面把房屋渲染成死文本，只能记下房号再去别的页面重搜，
 * 这是最常见的断头路。凡出现房屋一律走本组件。
 *
 * houseId 缺失时（历史数据或接口未返回）自动降级为不可点文本，
 * 而不是给一个点了报错的链接。
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';

const props = defineProps<{
  houseId?: string | null;
  /** 房屋对象，取 displayName / code 之一显示 */
  house?: { displayName?: string | null; code?: string | null } | null;
  /** 直接指定主文案（优先于 house） */
  text?: string | null;
  /** 次要行，如业主姓名或小区名 */
  sub?: string | null;
}>();

const router = useRouter();

const mainText = computed(
  () => props.text || props.house?.displayName || props.house?.code || '—',
);

function open() {
  if (props.houseId) router.push(`/houses/${props.houseId}`);
}
</script>
