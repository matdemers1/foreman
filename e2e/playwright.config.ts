import { defineConfig, devices } from '@playwright/test';

/**
 * Against a **running Foreman** — the Compose stack, not a dev server.
 *
 * The exit demo is "log in twice, land on the console, seed, blackhole the issuer, log in again",
 * and every one of those steps is a property of the deployed thing rather than of a bundle. So the
 * suite drives what actually ships: the API serving the built console at one origin.
 */
export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env['FOREMAN_URL'] ?? 'http://127.0.0.1:3200',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
