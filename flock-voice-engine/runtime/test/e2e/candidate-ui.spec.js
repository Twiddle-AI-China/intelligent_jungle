import { expect, test } from '@playwright/test';

function isAllowedCandidateHttpRequest(value) {
  const url = new URL(value);
  if (url.origin !== 'http://127.0.0.1:18090') return false;
  if (url.pathname === '/api/v1/bootstrap'
      || /^\/api\/v1\/latent-maps\/(bass|pad|melody)$/.test(url.pathname)) return true;
  return url.pathname === '/flock-voice-engine/runtime/test/fixtures/candidate-ui/index.html'
    || url.pathname === '/'
    || url.pathname === '/flock-voice-engine/runtime/test/fixtures/candidate-ui/shadow-app.js'
    || url.pathname === '/flock-voice-engine/runtime/test/fixtures/candidate-ui/candidate-main.js'
    || url.pathname.startsWith('/mvp/src/')
    || url.pathname.startsWith('/mvp/assets/');
}

test('candidate network allowlist rejects an arbitrary exfiltration origin', () => {
  expect(isAllowedCandidateHttpRequest('https://attacker.test/collect')).toBe(false);
  expect(isAllowedCandidateHttpRequest('http://127.0.0.1:18090/api/v1/audio')).toBe(false);
});

test('candidate reads the authoritative localhost runtime and advances revisions', async ({ page, request }) => {
  const browserRequests = [];
  const browserSockets = [];
  page.on('request', (browserRequest) => browserRequests.push(browserRequest.url()));
  page.on('websocket', (socket) => browserSockets.push(socket.url()));
  const health = await request.get('http://127.0.0.1:8090/healthz');
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual(expect.objectContaining({
    releaseRevision: 'unknown',
    sourceManifestSha256: 'unknown',
    runtimeOwner: 'browser',
    audioOwner: 'legacy',
    workerReady: false,
  }));
  const ready = await request.get('http://127.0.0.1:8090/readyz');
  expect(ready.status()).toBe(503);
  expect(await ready.json()).toEqual(expect.objectContaining({
    releaseRevision: 'unknown',
    sourceManifestSha256: 'unknown',
    workerReady: false,
    phaseGate: 'shadow-no-audio',
  }));

  await page.goto('');
  await expect(page.locator('[data-runtime-status]')).toHaveText('ready');
  await expect(page.locator('[data-world-generation]')).not.toHaveText('');
  const firstRevision = Number(await page.locator('[data-revision]').textContent());
  await expect.poll(async () => Number(
    await page.locator('[data-revision]').textContent(),
  )).toBeGreaterThan(firstRevision);
  expect(await page.evaluate(() => Object.isFrozen(
    globalThis.__candidateRuntime.client.getSnapshot(),
  ))).toBe(true);
  expect(await page.evaluate(() => (
    globalThis.__candidateRuntime.client.getSnapshot().agentStatus
  ))).toEqual(expect.objectContaining({
    species: expect.objectContaining({ source: 'policy', status: 'disabled' }),
    master: expect.objectContaining({ source: 'policy', status: 'disabled' }),
  }));
  await expect(page.locator('[data-agent-species]')).toHaveText('policy:disabled');
  await expect(page.locator('[data-agent-master]')).toHaveText('policy:disabled');

  await page.locator('[data-command="runtime.pause"]').click();
  await expect.poll(async () => page.evaluate(() => (
    globalThis.__candidateRuntime.diagnostics.lastCommandResult?.code
  ))).toBe('OK');
  expect(await page.evaluate(() => (
    globalThis.__candidateRuntime.client.getSnapshot().paused
  ))).toBe(true);
  await page.locator('[data-command="runtime.resume"]').click();
  await expect.poll(async () => page.evaluate(() => (
    globalThis.__candidateRuntime.diagnostics.lastCommandResult?.paused
  ))).toBe(false);
  expect(browserRequests.length).toBeGreaterThan(0);
  for (const url of browserRequests) expect(isAllowedCandidateHttpRequest(url)).toBe(true);
  expect(browserSockets).toEqual(['ws://127.0.0.1:18090/api/v1/runtime']);
});
