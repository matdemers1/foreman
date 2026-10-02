import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The console's unit tests render components to static markup in Node — structure, not behaviour;
 * the e2e suite drives the real thing. `@d3cloud/ui` is inlined because its bundle imports its own
 * stylesheet, which Node cannot load and Vite can (as nothing, here: `css` is off).
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    server: { deps: { inline: ['@d3cloud/ui'] } },
  },
});
