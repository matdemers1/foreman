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
    proxy: { '/api': 'http://localhost:3200', '/auth': 'http://localhost:3200' },
  },
});
