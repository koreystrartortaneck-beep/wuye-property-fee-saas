<template>
  <div class="empty">
    <span v-if="icon" class="empty-icon">{{ icon }}</span>
    <p class="empty-title">{{ title }}</p>
    <p v-if="desc" class="empty-desc">{{ desc }}</p>
    <div v-if="action || $slots.action" class="empty-actions">
      <slot name="action">
        <el-button type="primary" @click="go">{{ action!.label }}</el-button>
      </slot>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 统一空状态。
 *
 * 为什么要组件化：改版前 12 个页面各自复制了一份空状态标记与样式，
 * 而其中只有 1 处给了可点的下一步——例如「房屋」页空时写着
 * 「先到『设置 → 小区信息』创建小区」，却要用户自己去找那个入口。
 * 这里把「下一步」做成一等参数，空状态因此总是闭环的。
 *
 * action 传 { label, to } 走路由跳转；需要触发本页动作（打开弹窗等）时
 * 用 #action 插槽自定义按钮。
 */
import { useRouter } from 'vue-router';

const props = defineProps<{
  /** 一句话说明「现在是空的」 */
  title: string;
  /** 补充说明「为什么空 / 数据从哪来」 */
  desc?: string;
  /** 装饰性图标（emoji 即可，不引入图标库徒增体积） */
  icon?: string;
  /** 下一步动作：跳转到某个页面 */
  action?: { label: string; to: string };
}>();

const router = useRouter();

function go() {
  if (props.action) router.push(props.action.to);
}
</script>
