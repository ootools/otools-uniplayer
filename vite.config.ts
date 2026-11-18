import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { otoolsTauriShimPlugin } from 'otools-plugin-sdk/vite';

export default defineConfig({
  base: './',
  plugins: [otoolsTauriShimPlugin(), vue()],
  define: { __OTOOLS_PLUGIN_UUID__: JSON.stringify('otools-uniplayer') },
  server: { host: '127.0.0.1', port: 6576, strictPort: true },
  preview: { host: '127.0.0.1', port: 6577, strictPort: true },
  build: {
    target: 'es2022', outDir: 'dist', emptyOutDir: true,
    rollupOptions: { output: { manualChunks: { hls: ['hls.js'] } } },
  },
});
