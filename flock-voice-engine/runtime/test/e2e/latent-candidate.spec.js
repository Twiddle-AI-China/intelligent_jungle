import { expect, test } from '@playwright/test';

async function waitReady(page) {
  await page.goto('');
  await expect(page.locator('[data-runtime-status]')).toHaveText('ready');
  await expect.poll(() => page.evaluate(() => (
    globalThis.__candidateRuntime.client.getSnapshot()?.latent?.melody?.owner
  ))).toBe('AGENT');
}

test('two candidate clients share one authoritative latent lease and reconnect safely', async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  try {
    await Promise.all([waitReady(first), waitReady(second)]);
    const opened = await first.evaluate(async () => {
      const accepted = await globalThis.__candidateRuntime.openLatent('melody');
      return {
        accepted,
        live: document.querySelector('.candidate-latent-live')?.textContent ?? null,
        lastCommandResult: globalThis.__candidateRuntime.diagnostics.lastCommandResult,
        status: globalThis.__candidateRuntime.status(),
      };
    });
    expect(opened.accepted, JSON.stringify(opened)).toBe(true);
    expect(await first.evaluate(() => (
      JSON.stringify(globalThis.__candidateRuntime.diagnostics).includes('leaseToken')
    ))).toBe(false);
    await expect.poll(() => second.evaluate(() => (
      globalThis.__candidateRuntime.client.getSnapshot().latent.melody.owner
    ))).toBe('USER');
    expect(await second.evaluate(() => globalThis.__candidateRuntime.openLatent('melody'))).toBe(false);

    await first.waitForTimeout(3_200);
    expect(await first.evaluate(() => (
      globalThis.__candidateRuntime.client.getSnapshot().latent.melody.owner
    ))).toBe('USER');

    const preview = first.locator('[data-preview="hold"]');
    await preview.dispatchEvent('pointerdown');
    await expect.poll(() => second.evaluate(() => (
      globalThis.__candidateRuntime.client.getSnapshot().latent.melody.preview.active
    ))).toBe(true);
    expect(await second.evaluate(() => {
      const state = globalThis.__candidateRuntime.client.getSnapshot().latent.melody.preview;
      return { audible: state.audible, phaseGate: state.phaseGate };
    })).toEqual({ audible: false, phaseGate: 'shadow-no-audio' });
    await preview.dispatchEvent('pointerup');
    await expect.poll(() => second.evaluate(() => (
      globalThis.__candidateRuntime.client.getSnapshot().latent.melody.preview.active
    ))).toBe(false);

    await first.evaluate(() => globalThis.__candidateRuntime.closeSocketAfter());
    await expect.poll(() => second.evaluate(() => (
      globalThis.__candidateRuntime.client.getSnapshot().latent.melody.owner
    ))).toBe('AGENT');
    await expect(first.locator('[data-runtime-status]')).toHaveText('ready');
    await expect.poll(() => first.evaluate(() => (
      globalThis.__candidateRuntime.client.getSnapshot().latent.melody.owner
    ))).toBe('AGENT');
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});
