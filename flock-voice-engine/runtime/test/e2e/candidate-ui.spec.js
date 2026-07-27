import { expect, test } from '@playwright/test';

test('candidate reads the authoritative localhost runtime and advances revisions', async ({ page, request }) => {
  const health = await request.get('http://127.0.0.1:18090/healthz');
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual(expect.objectContaining({
    releaseRevision: 'unknown',
    sourceManifestSha256: 'unknown',
    runtimeOwner: 'browser',
    audioOwner: 'legacy',
    workerReady: false,
  }));
  const ready = await request.get('http://127.0.0.1:18090/readyz');
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
});
