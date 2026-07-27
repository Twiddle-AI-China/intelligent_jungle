import { expect, test } from '@playwright/test';

test('resume replays a covered gap and snapshots after journal retention is exceeded', async ({ page }) => {
  await page.goto('');
  await expect(page.locator('[data-runtime-status]')).toHaveText('ready');

  const replayBaseline = await page.evaluate(() => (
    globalThis.__candidateRuntime.closeSocketAfter(350)
  ));
  await expect.poll(async () => page.evaluate(
    () => globalThis.__candidateRuntime.status().phase,
  )).toBe('ready');
  await expect.poll(async () => page.evaluate(
    () => globalThis.__candidateRuntime.diagnostics.socketOpens,
  )).toBeGreaterThan(replayBaseline.socketOpens);
  await expect.poll(async () => page.evaluate(
    () => globalThis.__candidateRuntime.status().revision,
  )).toBeGreaterThan(replayBaseline.revision);
  await expect.poll(async () => page.evaluate(
    () => globalThis.__candidateRuntime.diagnostics.frameTypes.filter(
      (type) => type === 'state.patch',
    ).length,
  )).toBeGreaterThan(replayBaseline.patches);
  expect(await page.evaluate(() => globalThis.__candidateRuntime.diagnostics.frameTypes.filter(
    (type) => type === 'snapshot',
  ).length)).toBe(replayBaseline.snapshots);

  const gapBaseline = await page.evaluate(() => (
    globalThis.__candidateRuntime.closeSocketAndHold()
  ));
  const advancedHead = await page.evaluate(() => (
    globalThis.__candidateRuntime.advanceRuntimeRecords(264)
  ));
  expect(advancedHead.revision).toBeGreaterThan(gapBaseline.revision + 256);
  expect(await page.evaluate(() => (
    globalThis.__candidateRuntime.diagnostics.socketOpens
  ))).toBe(gapBaseline.socketOpens);
  expect(await page.evaluate(() => (
    globalThis.__candidateRuntime.status().revision
  ))).toBe(gapBaseline.revision);
  await page.evaluate(() => globalThis.__candidateRuntime.releaseReconnect());
  await expect.poll(async () => page.evaluate(
    () => globalThis.__candidateRuntime.diagnostics.socketOpens,
  )).toBeGreaterThan(gapBaseline.socketOpens);
  await expect.poll(async () => page.evaluate(
    () => globalThis.__candidateRuntime.diagnostics.frameTypes.filter(
      (type) => type === 'snapshot',
    ).length,
  ), { timeout: 15_000 }).toBeGreaterThan(gapBaseline.snapshots);
  await expect.poll(async () => page.evaluate(
    () => globalThis.__candidateRuntime.status().phase,
  )).toBe('ready');
});
