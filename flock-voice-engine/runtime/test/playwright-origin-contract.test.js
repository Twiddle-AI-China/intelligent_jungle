import assert from 'node:assert/strict';
import test from 'node:test';

import acceptanceConfig from '../playwright.phase5-acceptance.config.js';
import { createPlaywrightConfig } from '../playwright.config.js';

test('Playwright browser surfaces use one Node origin and a separate internal ops readiness probe',
  () => {
    const shadow = createPlaywrightConfig(['candidate-ui.spec.js']);
    const phase5 = createPlaywrightConfig(['phase5-local.spec.js']);
    for (const config of [shadow, phase5]) {
      assert.equal(config.use.baseURL, 'http://127.0.0.1:18090/');
      assert.equal(config.webServer.length, 1);
      assert.equal(config.webServer[0].url, 'http://127.0.0.1:8090/healthz');
      assert.doesNotMatch(config.webServer[0].command, /python|http\.server|4193/i);
      assert.equal(JSON.stringify(config).includes('4193'), false);
    }
    assert.equal(shadow.webServer[0].command, 'node test/fixtures/phase34-e2e-server.mjs');
    assert.equal(phase5.webServer[0].command, 'node test/fixtures/phase5-e2e-server.mjs');
  });

test('equivalent-host Chromium acceptance consumes the already staged Node origin', () => {
  assert.equal(acceptanceConfig.projects.length, 1);
  assert.equal(
    acceptanceConfig.projects[0].use.baseURL,
    'http://127.0.0.1:18090/',
  );
  assert.equal(Object.hasOwn(acceptanceConfig, 'webServer'), false);
  assert.equal(JSON.stringify(acceptanceConfig).includes('4193'), false);
});
