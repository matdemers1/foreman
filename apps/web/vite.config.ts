import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    manifest: true,
    sourcemap: false,
  },
  server: {
    port: 5273,
    // Everything the console talks to lives on the API, which also serves it in production.
    // `/health` and `/webhooks` are here for the e2e suite rather than the console: running it
    // against this server otherwise fails three tests that never touch the UI, which reads as a
    // regression and is not one.
    proxy: {
      '/api': 'http://localhost:3200',
      '/auth': 'http://localhost:3200',
      '/health': 'http://localhost:3200',
      '/readyz': 'http://localhost:3200',
      '/webhooks': 'http://localhost:3200',
    },
  },
});
