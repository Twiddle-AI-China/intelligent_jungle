import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProductionGraph } from '../helpers/import-graph.js';

const ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const BROWSER_GRAPH = buildProductionGraph({ repoRoot: ROOT,
  roots: [{ kind: 'html', path: 'mvp/index.html' }] });
const STATIC_PATHS = new Set(BROWSER_GRAPH.files.map((path) => `/${path}`));
const RUNTIME_PATHS = new Set([
  '/api/v1/bootstrap', '/api/v1/latent-maps/bass',
  '/api/v1/latent-maps/melody', '/api/v1/latent-maps/pad',
]);

test('production UI consumes snapshots, PCM, reconnects, and sends intents only', async ({ page }, testInfo) => {
  test.skip(testInfo.config.metadata.phase5Mode !== true,
    'phase5 production profile has its own fixed localhost server');
  const requests = [];
  page.on('request', (request) => requests.push({ method: request.method(), rawUrl: request.url() }));
  await page.addInitScript(() => {
    const NativeWebSocket = globalThis.WebSocket;
    const NativeAudioContext = globalThis.AudioContext;
    const NativeWorkletNode = globalThis.AudioWorkletNode;
    globalThis.__phase5 = { sockets: [], binary: 0, contexts: 0, worklets: 0,
      oscillators: 0, bufferSources: 0, convolvers: 0 };
    globalThis.WebSocket = class InstrumentedWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        const record = { url: String(url), socket: this };
        globalThis.__phase5.sockets.push(record);
        this.addEventListener('message', (event) => {
          if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
            globalThis.__phase5.binary += 1;
          }
        });
      }
    };
    globalThis.AudioContext = class InstrumentedAudioContext extends NativeAudioContext {
      constructor(options) { super(options); globalThis.__phase5.contexts += 1; }
    };
    globalThis.webkitAudioContext = globalThis.AudioContext;
    globalThis.AudioWorkletNode = class InstrumentedWorkletNode extends NativeWorkletNode {
      constructor(...args) { super(...args); globalThis.__phase5.worklets += 1; }
    };
    for (const [method, key] of [['createOscillator', 'oscillators'],
      ['createBufferSource', 'bufferSources'], ['createConvolver', 'convolvers']]) {
      const original = NativeAudioContext.prototype[method];
      NativeAudioContext.prototype[method] = function instrumented(...args) {
        globalThis.__phase5[key] += 1;
        return original.apply(this, args);
      };
    }
  });

  await page.goto('http://127.0.0.1:4193/mvp/index.html');
  await page.locator('#start-btn').click();
  await expect(page.locator('[data-runtime-status]')).toHaveText('server runtime ready');
  await expect(page.locator('[data-world-generation]')).not.toHaveText('');
  await expect.poll(() => page.evaluate(() => globalThis.__phase5.binary)).toBeGreaterThanOrEqual(3);
  await expect.poll(() => page.evaluate(() => globalThis.__phase5.worklets)).toBe(1);

  const beforeRevision = Number(await page.locator('[data-revision]').textContent());
  await page.locator('[data-bpm="70"]').dispatchEvent('click');
  await expect.poll(async () => Number(await page.locator('[data-revision]').textContent()))
    .toBeGreaterThan(beforeRevision);

  await page.evaluate(() => {
    globalThis.__phase5.sockets.find(({ url }) => url.endsWith('/api/v1/runtime')).socket.close();
  });
  await expect.poll(() => page.evaluate(() => globalThis.__phase5.sockets
    .filter(({ url }) => url.endsWith('/api/v1/runtime')).length)).toBe(2);
  await expect(page.locator('[data-runtime-status]')).toHaveText('server runtime ready');

  await page.evaluate(() => {
    globalThis.__phase5.sockets.find(({ url }) => url.endsWith('/api/v1/audio')).socket.close();
  });
  await expect.poll(() => page.evaluate(() => globalThis.__phase5.sockets
    .filter(({ url }) => url.endsWith('/api/v1/audio')).length)).toBe(2);
  await expect.poll(() => page.evaluate(() => globalThis.__phase5.binary)).toBeGreaterThanOrEqual(6);

  await page.locator('[data-open-latent="melody"]').dispatchEvent('click');
  await expect(page.locator('.candidate-latent-roamer')).toBeVisible();
  await expect(page.locator('.candidate-latent-live')).toContainText('melody');
  await page.locator('[data-preview="hold"]').dispatchEvent('pointerdown');
  await page.locator('[data-preview="hold"]').dispatchEvent('pointerup');

  const productionSockets = await page.evaluate(() => globalThis.__phase5.sockets
    .map(({ url }) => new URL(url).pathname).sort());
  expect(productionSockets).toEqual([
    '/api/v1/audio', '/api/v1/audio', '/api/v1/runtime', '/api/v1/runtime',
  ]);

  const legacyRejected = page.evaluate(() => new Promise((resolve) => {
    const socket = new WebSocket('ws://127.0.0.1:18090/decoder');
    socket.addEventListener('open', () => resolve(false));
    socket.addEventListener('error', () => resolve(true));
    socket.addEventListener('close', () => resolve(true));
  }));
  expect(await legacyRejected).toBe(true);

  const diagnostics = await page.evaluate(() => ({ ...globalThis.__phase5,
    sockets: globalThis.__phase5.sockets.map(({ url }) => url) }));
  expect(diagnostics.contexts).toBeGreaterThanOrEqual(1);
  expect(diagnostics.oscillators).toBe(0);
  expect(diagnostics.bufferSources).toBe(0);
  expect(diagnostics.convolvers).toBe(0);
  for (const request of requests) {
    const url = new URL(request.rawUrl);
    expect(request.method, request.rawUrl).toBe('GET');
    expect(url.search, request.rawUrl).toBe('');
    if (url.origin === 'http://127.0.0.1:4193') {
      expect(STATIC_PATHS.has(url.pathname), request.rawUrl).toBe(true);
    } else if (url.origin === 'http://127.0.0.1:18090') {
      expect(RUNTIME_PATHS.has(url.pathname), request.rawUrl).toBe(true);
    } else expect(false, `unexpected production HTTP origin: ${request.rawUrl}`).toBe(true);
  }
});
