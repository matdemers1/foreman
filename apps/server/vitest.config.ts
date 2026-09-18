import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Named projects, because CI gates in layers: lint → unit → integration → e2e (FRM-REQ-008).
// The integration project is the only one that needs a database.
export default defineConfig({
  resolve: {
    alias: {
      // The package resolves to `dist` at runtime, which is right for the image and wrong for a
      // test run: nobody should have to build a sibling package to run a unit test.
      '@foreman/shared': resolve(import.meta.dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // Creates the database if needed and migrates it, so a dropped volume costs nothing.
          globalSetup: ['test/integration/global-setup.ts'],
          // A shared database makes these order-dependent; they run one file at a time.
          fileParallelism: false,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
