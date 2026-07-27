import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { buildProductionGraph } from '../helpers/import-graph.js';

const ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const BROWSER_GRAPH = buildProductionGraph({ repoRoot: ROOT,
  roots: [{ kind: 'html', path: 'mvp/index.html' }] });
const STATIC_PATHS = new Set(BROWSER_GRAPH.files.map((path) => `/${path}`));
const RUNTIME_PATHS = new Set([
  '/api/v1/bootstrap', '/api/v1/latent-maps/bass',
  '/api/v1/latent-maps/melody', '/api/v1/latent-maps/pad',
]);

async function takeMaintenanceLease(decoderSessionId) {
  const tokenPath = process.env.PHASE5_MAINTENANCE_TOKEN_PATH;
  if (!tokenPath) throw new Error('PHASE5_MAINTENANCE_TOKEN_REQUIRED');
  const credential = await readFile(tokenPath, 'utf8');
  const bootstrapResponse = await fetch('http://127.0.0.1:18090/api/v1/bootstrap', {
    headers: { origin: 'http://127.0.0.1:4193' },
  });
  if (!bootstrapResponse.ok) throw new Error('MAINTENANCE_BOOTSTRAP_FAILED');
  const bootstrap = await bootstrapResponse.json();
  const socket = new WebSocket('ws://127.0.0.1:18090/api/v1/runtime', {
    origin: 'http://127.0.0.1:4193',
  });
  const pending = new Map();
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === 'command.result') pending.get(frame.commandId)?.(frame);
  });
  await new Promise((done, reject) => { socket.once('open', done); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'hello', protocolVersion: 1, clientId: bootstrap.clientId,
    bootstrapToken: bootstrap.bootstrapToken, worldGeneration: bootstrap.worldGeneration,
    lastRevision: bootstrap.revision, lastEventSeq: bootstrap.eventSeq }));
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('MAINTENANCE_READY_TIMEOUT')), 5000);
    const listener = (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'ready') { clearTimeout(timer); socket.off('message', listener); done(); }
    };
    socket.on('message', listener);
  });
  const command = (name, payload) => new Promise((done, reject) => {
    const commandId = randomUUID();
    const timer = setTimeout(() => reject(new Error('MAINTENANCE_COMMAND_TIMEOUT')), 10000);
    pending.set(commandId, (frame) => {
      clearTimeout(timer); pending.delete(commandId);
      if (frame.accepted !== true) reject(new Error(frame.code ?? 'MAINTENANCE_COMMAND_REJECTED'));
      else done(frame);
    });
    socket.send(JSON.stringify({ type: 'command', protocolVersion: 1, commandId,
      worldGeneration: bootstrap.worldGeneration, baseRevision: bootstrap.revision, name, payload }));
  });
  const authenticated = await command('maintenance.authenticate', { credential });
  const taken = await command('legacy.take', { maintenanceToken: authenticated.maintenanceToken,
    decoderSessionId });
  return { taken, async release() {
    const released = await command('legacy.release', {
      maintenanceToken: authenticated.maintenanceToken,
      decoderSessionId, leaseToken: taken.leaseToken,
    });
    socket.close(1000); return released;
  } };
}

async function decoderSession(page, selector) {
  await expect.poll(async () => {
    const match = (await page.locator(selector).textContent())?.match(/decoder-[A-Za-z0-9-]+/);
    return match?.[0] ?? '';
  }).not.toBe('');
  return (await page.locator(selector).textContent()).match(/decoder-[A-Za-z0-9-]+/)[0];
}

async function workerAppliedSeq() {
  const response = await fetch('http://127.0.0.1:18090/readyz');
  const value = await response.json();
  if (!response.ok || !Number.isSafeInteger(value?.workerTelemetry?.appliedCommandSeq)) {
    throw new Error('WORKER_APPLIED_SEQUENCE_REQUIRED');
  }
  return value.workerTelemetry.appliedCommandSeq;
}

async function waitForAppliedCommand(afterSeq, expected, signalRow = null) {
  await expect.poll(async () => {
    const response = await fetch('http://127.0.0.1:18090/readyz');
    const value = await response.json();
    if (!response.ok || !Number.isSafeInteger(value?.workerTelemetry?.appliedCommandSeq)) return 0;
    const matched = value.audioCommandAudit?.filter((batch) => batch.commandSeq > afterSeq
      && batch.commands.some((command) => Object.entries(expected)
        .every(([name, expectedValue]) => command[name] === expectedValue)))
      .map((batch) => batch.commandSeq).sort((a, b) => a - b)[0];
    const peaks = value.workerTelemetry.rowMasterContributionPeakAbs;
    const signal = signalRow === null || (Number.isFinite(peaks?.[signalRow])
      && peaks[signalRow] > 1e-7);
    return matched && value.workerTelemetry.appliedCommandSeq >= matched && signal ? matched : 0;
  }).toBeGreaterThan(afterSeq);
  const response = await fetch('http://127.0.0.1:18090/readyz');
  const value = await response.json();
  return value.audioCommandAudit.filter((batch) => batch.commandSeq > afterSeq
    && batch.commandSeq <= value.workerTelemetry.appliedCommandSeq
    && batch.commands.some((command) => Object.entries(expected)
      .every(([name, expectedValue]) => command[name] === expectedValue)))
    .map((batch) => batch.commandSeq).sort((a, b) => a - b)[0];
}

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

  const leaseEvidence = { schemaVersion: 1,
    kind: 'production-fixed-entry-chromium-lease-evidence',
    sequence: [], surfaceLeases: {}, audibleSpecies: {} };
  if (testInfo.config.metadata.phase5Acceptance === true) {
  await page.goto('http://127.0.0.1:18090/demo.html');
  await page.locator('#btn-connect').click();
  await expect(page.locator('#mode')).toContainText('streaming');
  const demoLease = await takeMaintenanceLease(await decoderSession(page, '#log'));
  leaseEvidence.sequence.push('demo');
  for (const [row, species] of ['bass', 'pad', 'lead', 'pluck'].entries()) {
    await page.locator('#voice').selectOption(String(row));
    const beforeSeq = await workerAppliedSeq();
    const key = page.locator('#keys [data-midi="60"]');
    await key.dispatchEvent('mousedown'); await page.waitForTimeout(300);
    const appliedSeq = await waitForAppliedCommand(beforeSeq, { type: 'note.on', row }, row);
    const before = await page.evaluate(() => globalThis.__phase5.binary);
    await expect.poll(() => page.evaluate(() => globalThis.__phase5.binary)).toBeGreaterThan(before);
    const after = await page.evaluate(() => globalThis.__phase5.binary);
    const peakAbs = (await fetch('http://127.0.0.1:18090/readyz')
      .then((response) => response.json())).workerTelemetry.rowMasterContributionPeakAbs[row];
    await key.dispatchEvent('mouseup');
    const releasedSeq = await waitForAppliedCommand(appliedSeq, { type: 'note.off', row });
    leaseEvidence.audibleSpecies[species] = { commandAccepted: true,
      releaseAccepted: true, commandSeq: appliedSeq, releaseCommandSeq: releasedSeq,
      peakAbs, pcmBlocks: after - before };
  }
  const demoReleased = await demoLease.release();
  expect(demoReleased.released).toBe(true);
  leaseEvidence.surfaceLeases.demo = { takeAccepted: demoLease.taken.accepted === true,
    releaseAccepted: demoReleased.accepted === true && demoReleased.released === true };
  await page.locator('#btn-disconnect').click();

  await page.goto('http://127.0.0.1:18090/tracks.html');
  await page.locator('#start').click();
  await expect(page.locator('#stat')).toContainText('streaming');
  const tracksLease = await takeMaintenanceLease(await decoderSession(page, '#stat'));
  leaseEvidence.sequence.push('tracks');
  for (let row = 0; row < 4; row += 1) await page.locator(`#play${row}`).click();
  const tracksReleased = await tracksLease.release();
  expect(tracksReleased.released).toBe(true);
  leaseEvidence.surfaceLeases.tracks = { takeAccepted: tracksLease.taken.accepted === true,
    releaseAccepted: tracksReleased.accepted === true && tracksReleased.released === true };
  await page.locator('#stop').click();

  requests.length = 0;
  }

  await page.goto('http://127.0.0.1:4193/mvp/index.html');
  await page.locator('#start-btn').click();
  await expect(page.locator('[data-runtime-status]')).toHaveText('server runtime ready');
  await expect(page.locator('[data-world-generation]')).not.toHaveText('');
  const readyResponse = await fetch('http://127.0.0.1:18090/readyz');
  const readyEvidence = await readyResponse.json();
  await testInfo.attach('phase5-runtime-identity', {
    body: Buffer.from(JSON.stringify({ status: readyResponse.status, value: readyEvidence })),
    contentType: 'application/json',
  });
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
  const newUiTakeSeq = testInfo.config.metadata.phase5Acceptance === true
    ? await workerAppliedSeq() : null;
  await page.locator('[data-preview="hold"]').dispatchEvent('pointerdown');
  const newUiAppliedSeq = newUiTakeSeq === null ? null
    : await waitForAppliedCommand(newUiTakeSeq, { type: 'preview.start', voice: 'lead' });
  await page.locator('[data-preview="hold"]').dispatchEvent('pointerup');
  if (newUiAppliedSeq !== null) {
    const newUiReleasedSeq = await waitForAppliedCommand(newUiAppliedSeq,
      { type: 'preview.allOff', voice: 'lead' });
    leaseEvidence.sequence.push('new-ui');
    leaseEvidence.surfaceLeases['new-ui'] = { takeAccepted: true, releaseAccepted: true,
      commandSeq: newUiAppliedSeq, releaseCommandSeq: newUiReleasedSeq };
    await testInfo.attach('phase5-lease-evidence', {
      body: Buffer.from(JSON.stringify(leaseEvidence)), contentType: 'application/json',
    });
  }

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
