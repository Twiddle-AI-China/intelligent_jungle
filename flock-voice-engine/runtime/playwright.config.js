import { defineConfig } from '@playwright/test';

const phase5Mode = process.argv.some((argument) => argument.includes('phase5-local.spec'));
const candidateUrl = phase5Mode
  ? 'http://127.0.0.1:4193/mvp/index.html'
  : 'http://127.0.0.1:4193/flock-voice-engine/runtime/test/fixtures/candidate-ui/index.html';

export default defineConfig({
  metadata: { phase5Mode },
  testDir: './test/e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: candidateUrl,
    browserName: 'chromium',
    headless: true,
  },
  webServer: [
    {
      command: phase5Mode
        ? 'node test/fixtures/phase5-e2e-server.mjs'
        : 'node test/fixtures/phase34-e2e-server.mjs',
      url: 'http://127.0.0.1:18090/healthz',
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: 'python -m http.server 4193 --bind 127.0.0.1 --directory ../..',
      url: candidateUrl,
      reuseExistingServer: false,
      timeout: 20_000,
    },
  ],
});
