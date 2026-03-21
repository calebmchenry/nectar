import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/gardens': 'http://localhost:4140',
      '/pipelines': 'http://localhost:4140',
      '/events': 'http://localhost:4140',
      '/seeds': 'http://localhost:4140',
      '/health': 'http://localhost:4140',
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
  },
});
