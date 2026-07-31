import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/*
 * 生产部署必须用 `pnpm build:prod`，不是 `pnpm build`。
 *
 * 线上后台挂在 http://<host>/wuye-admin/ 下，API 走 /wuye/api/v1 ——
 * 两者都要在构建时定死：
 *   base=/wuye-admin/     否则产物里的资源路径是 /assets/...，部署后全部 404（白屏）
 *   VITE_API_BASE         否则前端请求 /api/v1，nginx 上没有这个位置
 *
 * `pnpm -r build`（仓库级构建）跑的是默认的 `build`，产物**不能**直接部署到 /wuye-admin/。
 * 这两个参数原本只存在于操作者的记忆里，写进 package.json 的 build:prod 里，
 * 并由 apps/admin/src/build-config.spec.ts 钉住。
 */
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // dev 直连本地 API
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});
