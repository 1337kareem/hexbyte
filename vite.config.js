import { defineConfig } from 'vite';

export default defineConfig({
  server: { proxy: { '/api': 'http://localhost:8788' } },
  build: {
    rollupOptions: { input: { main: 'index.html', rune: 'rune.html' } },
    chunkSizeWarningLimit: 1500,
  },
});
