import { expect, test } from '@playwright/test';

test('candidate performs no audio, decoder, provider, or PCM activity', async ({ page }) => {
  const requests = [];
  await page.addInitScript(() => {
    globalThis.__audioConstructors = { context: 0, worklet: 0 };
    globalThis.AudioContext = class ForbiddenAudioContext {
      constructor() { globalThis.__audioConstructors.context += 1; }
    };
    globalThis.webkitAudioContext = globalThis.AudioContext;
    globalThis.AudioWorkletNode = class ForbiddenAudioWorkletNode {
      constructor() { globalThis.__audioConstructors.worklet += 1; }
    };
  });
  page.on('request', (request) => requests.push(request.url()));

  await page.goto('');
  await expect(page.locator('[data-runtime-status]')).toHaveText('ready');
  await page.waitForTimeout(500);

  expect(await page.evaluate(() => globalThis.__audioConstructors)).toEqual({
    context: 0,
    worklet: 0,
  });
  expect(requests.some((url) => (
    url.includes('/decoder')
    || url.includes('/api/v1/audio')
    || url.includes(':8081')
  ))).toBe(false);
});
