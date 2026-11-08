import { defineConfig } from 'vite';

export default defineConfig({
  server: { proxy: { '/api': 'http://localhost:8788' } },
  build: {
    rollupOptions: { input: { main: 'index.html', gate: 'gate.html' } },
    chunkSizeWarningLimit: 1500,
  },
});
