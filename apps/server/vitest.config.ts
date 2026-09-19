import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Named projects, because CI gates in layers: lint → unit → integration → e2e (FRM-REQ-008).
// The integration project is the only one that needs a database.
const alias = {
  // These packages resolve to `dist` at runtime, which is right for the image and wrong for a test
  // run: nobody should have to build a sibling package to run a test.
  //
  // Declared per project, not once at the top level: in `projects` mode a project does not inherit
  // the root `resolve`, so a top-level alias silently does nothing — which is easy to miss while
  // the sibling's `dist` happens to be lying around from an earlier build.
  '@foreman/shared': resolve(import.meta.dirname, '../../packages/shared/src/index.ts'),
  '@d3cloud/foreman-mcp/server': resolve(import.meta.dirname, '../../packages/mcp/src/server.ts'),
  '@d3cloud/foreman-mcp/client': resolve(import.meta.dirname, '../../packages/mcp/src/client.ts'),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
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
