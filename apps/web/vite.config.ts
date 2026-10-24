import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const API_TARGET = process.env.API_TARGET ?? 'http://127.0.0.1:8788';

// 开发服务器监听地址。默认固定为 IPv4 回环 127.0.0.1：
// Node 18+ 在 Windows 上把 `localhost` 解析成 ::1，Vite 默认只监听 [::1]，
// 于是 http://127.0.0.1:5173 会「积极拒绝」，而 http://localhost:5173 才通。
// 需要从局域网访问时用 WEB_HOST=0.0.0.0 npm run dev（会暴露端口，谨慎使用）。
const WEB_HOST = process.env.WEB_HOST ?? '127.0.0.1';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: WEB_HOST,
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/files': { target: API_TARGET, changeOrigin: true },
    },
  },
  preview: {
    host: WEB_HOST,
    port: 4173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/files': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
