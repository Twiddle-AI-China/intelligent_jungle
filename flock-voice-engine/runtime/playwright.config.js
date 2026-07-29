import { defineConfig } from '@playwright/test';

const candidateUrl = 'http://127.0.0.1:18090/';

export function createPlaywrightConfig(argv = process.argv) {
  const phase5Mode = argv.some((argument) => argument.includes('phase5-local.spec'));
  return defineConfig({
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
    webServer: [{
      command: phase5Mode
        ? 'node test/fixtures/phase5-e2e-server.mjs'
        : 'node test/fixtures/phase34-e2e-server.mjs',
      url: 'http://127.0.0.1:8090/healthz',
      reuseExistingServer: false,
      timeout: 30_000,
    }],
  });
}

export default createPlaywrightConfig();
