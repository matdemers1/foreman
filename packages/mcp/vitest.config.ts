import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Source, not the built output: nobody should have to build a sibling package to run a test.
      '@foreman/shared': resolve(import.meta.dirname, '../shared/src/index.ts'),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
