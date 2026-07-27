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
    baseURL: 'http://127.0.0.1:4193/mvp/index.html' } }],
  webServer: [{
    command: 'python -m http.server 4193 --bind 127.0.0.1 --directory ../..',
    url: 'http://127.0.0.1:4193/mvp/index.html',
    reuseExistingServer: false,
    timeout: 20_000,
  }],
});
