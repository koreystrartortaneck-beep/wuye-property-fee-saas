import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import './styles/tokens.css'; // 设计系统：必须在 element-plus 之后引入以覆盖其变量
import './styles/ui.css'; // 共享 UI 层（卡片/工具条/空状态等跨页结构），依赖 tokens 的变量
import App from './App.vue';
import { router } from './router';

createApp(App).use(router).use(ElementPlus, { locale: zhCn }).mount('#app');
