import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

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
