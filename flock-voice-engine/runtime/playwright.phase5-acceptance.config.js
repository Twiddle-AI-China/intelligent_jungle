import { defineConfig } from '@playwright/test';

export default defineConfig({
  metadata: {
    phase5Mode: true,
    phase5Acceptance: true,
    surfaceProfile: 'production-fixed-entry',
  },
  testDir: './test/e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', headless: true,
    baseURL: 'http://127.0.0.1:18090/' } }],
});
