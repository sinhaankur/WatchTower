import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'
import path from 'path'

const proxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000'

export default defineConfig({
  plugins: [
    react(),
    // ANALYZE=1 npm run build → opens dist/stats.html with treemap.
    process.env.ANALYZE && visualizer({ filename: 'dist/stats.html', open: true, gzipSize: true, brotliSize: true }),
  ].filter(Boolean) as any,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Pin slow-changing deps into vendor chunks so app-code deploys
        // don't bust the cache for return visitors. Function form is
        // required: the array form only matches bare specifiers like
        // `react-dom`, but React 18+ pulls in `react-dom/client` which
        // is a *different* path and ended up in the main bundle —
        // ballooning it past 300 KB. Matching by node_modules path
        // catches all subpaths of each package.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('@tanstack/react-query')) return 'vendor-query';
          if (id.includes('@radix-ui')) return 'vendor-radix';
          if (id.includes('node_modules/axios/')) return 'vendor-axios';
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/react-router-dom/') ||
            id.includes('node_modules/react-router/') ||
            id.includes('node_modules/scheduler/')
          ) {
            return 'vendor-react';
          }
        },
      },
    },
  },
})
