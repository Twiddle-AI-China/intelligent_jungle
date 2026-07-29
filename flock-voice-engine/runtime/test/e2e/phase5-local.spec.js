import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as nodeHttpRequest } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFixedProductionGraph } from '../../tools/production-graph-config.mjs';
import {
  openCandidateRuntimeSocket,
  readCandidateBootstrap,
} from '../../tools/lib/candidate-browser-transport.mjs';
import { readCandidateOps } from '../../tools/lib/candidate-ops.mjs';
import {
  canonicalJson,
  projectSurfaceTransports,
  validateLeaseEvidence,
} from '../../tools/lib/phase5-lease-evidence.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const CANDIDATE_ORIGIN = 'http://127.0.0.1:18090';
const BROWSER_GRAPH = buildFixedProductionGraph(ROOT);
const STATIC_PATHS = new Set(BROWSER_GRAPH.staticRoutes.map(({ url }) => url));
const RUNTIME_PATHS = new Set([
  '/api/decoder-status',
  '/api/v1/bootstrap', '/api/v1/latent-maps/bass',
  '/api/v1/latent-maps/melody', '/api/v1/latent-maps/pad',
]);
const MAINTENANCE_HEARTBEAT_MS = 750;
const READY_EVIDENCE_FIELDS = Object.freeze([
  'audioOwner', 'phaseGate', 'runtimeOwner', 'workerIdentity', 'workerReady',
]);
const SURFACE_ENTRY_PATHS = Object.freeze({
  demo: '/demo.html',
  tracks: '/tracks.html',
  'new-ui': '/',
});
const SURFACE_HTTP_LIMITS = Object.freeze({
  demo: 12,
  tracks: 16,
  'new-ui': 96,
});
const SURFACE_SOCKET_PATHS = Object.freeze({
  demo: Object.freeze(['/decoder']),
  tracks: Object.freeze(['/decoder?split=1']),
  'new-ui': Object.freeze([
    '/api/v1/audio', '/api/v1/audio', '/api/v1/runtime', '/api/v1/runtime', '/decoder',
  ]),
});

function maintenanceError(value, fallback) {
  return value instanceof Error ? value : new Error(fallback);
}

function createDisposerScope() {
  const disposers = [];
  return Object.freeze({
    register(disposer) {
      if (typeof disposer !== 'function') throw new Error('DISPOSER_REQUIRED');
      let attempt = null;
      const once = () => {
        if (attempt === null) attempt = Promise.resolve().then(disposer);
        return attempt;
      };
      disposers.unshift(once);
      return once;
    },
    async dispose() {
      const outcomes = await Promise.allSettled(disposers.map((dispose) => dispose()));
      const failures = outcomes.filter(({ status }) => status === 'rejected')
        .map(({ reason }) => reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'PHASE5_DISPOSAL_FAILED');
      }
    },
  });
}

function validMaintenanceBootstrap(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.protocolVersion === 1
    && typeof value.clientId === 'string'
    && value.clientId.length > 0
    && typeof value.bootstrapToken === 'string'
    && value.bootstrapToken.length > 0
    && typeof value.worldGeneration === 'string'
    && value.worldGeneration.length > 0
    && Number.isSafeInteger(value.revision)
    && value.revision >= 0
    && Number.isSafeInteger(value.eventSeq)
    && value.eventSeq >= 0;
}

async function takeMaintenanceLease(decoderSessionId, registerDisposer) {
  if (typeof registerDisposer !== 'function') throw new Error('DISPOSER_REQUIRED');
  const tokenPath = process.env.PHASE5_MAINTENANCE_TOKEN_PATH;
  if (!tokenPath) throw new Error('PHASE5_MAINTENANCE_TOKEN_REQUIRED');
  const credential = await readFile(tokenPath, 'utf8');
  const bootstrap = await readCandidateBootstrap();
  if (!validMaintenanceBootstrap(bootstrap)) throw new Error('MAINTENANCE_BOOTSTRAP_FAILED');
  const transport = await openCandidateRuntimeSocket();
  const { socket } = transport;
  const pending = new Map();
  let terminalError = null;
  let closing = false;
  let currentRevision = bootstrap.revision;
  let currentEventSeq = bootstrap.eventSeq;

  function settle(commandId, operation, value) {
    const entry = pending.get(commandId);
    if (!entry) return;
    pending.delete(commandId);
    clearTimeout(entry.timer);
    entry[operation](value);
  }

  function failPending(error) {
    for (const commandId of [...pending.keys()]) settle(commandId, 'reject', error);
  }

  function observeCursor(frame) {
    if (frame?.worldGeneration !== undefined
        && frame.worldGeneration !== bootstrap.worldGeneration) return;
    const revision = frame?.type === 'state.patch'
      ? frame.resultRevision
      : frame?.revision ?? frame?.currentRevision;
    const eventSeq = frame?.eventSeq ?? frame?.currentEventSeq;
    if (Number.isSafeInteger(revision) && revision >= currentRevision) {
      currentRevision = revision;
    }
    if (Number.isSafeInteger(eventSeq) && eventSeq >= currentEventSeq) {
      currentEventSeq = eventSeq;
    }
  }

  socket.on('message', (data) => {
    try {
      const frame = JSON.parse(data.toString());
      observeCursor(frame);
      if (frame.type === 'command.result' && typeof frame.commandId === 'string') {
        settle(frame.commandId, frame.accepted === true ? 'resolve' : 'reject',
          frame.accepted === true
            ? frame
            : new Error(frame.code ?? 'MAINTENANCE_COMMAND_REJECTED'));
      }
    } catch {
      // The protocol handshake below owns malformed-frame failure and timeout.
    }
  });
  socket.on('error', (error) => {
    const failure = maintenanceError(error, 'MAINTENANCE_SOCKET_ERROR');
    terminalError ??= failure;
    failPending(failure);
  });
  socket.on('close', () => {
    const failure = new Error('MAINTENANCE_SOCKET_CLOSED');
    terminalError ??= failure;
    failPending(failure);
  });

  async function closeTransport() {
    closing = true;
    await new Promise((done) => {
      if (socket.readyState >= 2) {
        done();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('close', finish);
        done();
      };
      const timer = setTimeout(() => {
        try { socket.terminate?.(); } catch { /* bounded cleanup is authoritative */ }
        finish();
      }, 250);
      socket.once('close', finish);
      try { socket.close(1000); } catch { finish(); }
    });
    transport.closeTransport();
  }

  try {
    const ready = new Promise((done, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('message', listener);
        socket.off('error', failed);
        socket.off('close', closed);
      };
      const finish = (operation, value) => {
        cleanup();
        operation(value);
      };
      const listener = (data) => {
        let frame;
        try { frame = JSON.parse(data.toString()); } catch { return; }
        if (frame.type === 'ready') finish(done, frame);
      };
      const failed = (error) => finish(reject,
        maintenanceError(error, 'MAINTENANCE_SOCKET_ERROR'));
      const closed = () => finish(reject, new Error('MAINTENANCE_SOCKET_CLOSED_BEFORE_READY'));
      socket.on('message', listener);
      socket.once('error', failed);
      socket.once('close', closed);
      timer = setTimeout(
        () => finish(reject, new Error('MAINTENANCE_READY_TIMEOUT')),
        5000,
      );
    });
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: 1, clientId: bootstrap.clientId,
      bootstrapToken: bootstrap.bootstrapToken, worldGeneration: bootstrap.worldGeneration,
      lastRevision: bootstrap.revision, lastEventSeq: bootstrap.eventSeq }));
    await ready;

    const command = (name, payload) => new Promise((done, reject) => {
      if (terminalError !== null) {
        reject(terminalError);
        return;
      }
      const commandId = randomUUID();
      const timer = setTimeout(() => {
        settle(commandId, 'reject', new Error('MAINTENANCE_COMMAND_TIMEOUT'));
      }, 10000);
      pending.set(commandId, { resolve: done, reject, timer });
      try {
        socket.send(JSON.stringify({ type: 'command', protocolVersion: 1, commandId,
          worldGeneration: bootstrap.worldGeneration, baseRevision: currentRevision,
          name, payload }), (error) => {
          if (error) settle(commandId, 'reject',
            maintenanceError(error, 'MAINTENANCE_SEND_FAILED'));
        });
      } catch (error) {
        settle(commandId, 'reject', maintenanceError(error, 'MAINTENANCE_SEND_FAILED'));
      }
    });
    const authenticated = await command('maintenance.authenticate', { credential });
    if (typeof authenticated.maintenanceToken !== 'string'
        || authenticated.maintenanceToken.length === 0) {
      throw new Error('MAINTENANCE_TOKEN_REQUIRED');
    }
    const taken = await command('legacy.take', { maintenanceToken: authenticated.maintenanceToken,
      decoderSessionId });
    if (typeof taken.leaseToken !== 'string' || taken.leaseToken.length === 0) {
      throw new Error('LEGACY_TAKE_LEASE_TOKEN_REQUIRED');
    }

    let heartbeatTimer = null;
    let heartbeatInFlight = null;
    let heartbeatFailure = null;
    let releaseAttempt = null;
    const heartbeatPayload = {
      maintenanceToken: authenticated.maintenanceToken,
      decoderSessionId,
      leaseToken: taken.leaseToken,
    };

    const release = () => {
      if (releaseAttempt !== null) return releaseAttempt;
      releaseAttempt = (async () => {
        closing = true;
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        if (heartbeatInFlight !== null) await heartbeatInFlight;
        const priorFailure = heartbeatFailure ?? terminalError;
        let released;
        let releaseFailure = null;
        try {
          released = await command('legacy.release', {
            ...heartbeatPayload,
          });
        } catch (error) {
          releaseFailure = error;
        } finally {
          await closeTransport();
        }
        if (priorFailure !== null) throw priorFailure;
        if (releaseFailure !== null) throw releaseFailure;
        return released;
      })();
      return releaseAttempt;
    };
    const lease = Object.freeze({ taken, release });
    registerDisposer(lease.release);

    heartbeatTimer = setInterval(() => {
      if (closing || heartbeatFailure !== null || heartbeatInFlight !== null) return;
      heartbeatInFlight = command('legacy.heartbeat', {
        ...heartbeatPayload,
      }).catch((error) => {
        heartbeatFailure = new Error(
          `MAINTENANCE_HEARTBEAT_FAILED:${error?.message ?? 'UNKNOWN'}`,
          { cause: error },
        );
      }).finally(() => {
        heartbeatInFlight = null;
      });
    }, MAINTENANCE_HEARTBEAT_MS);
    return lease;
  } catch (error) {
    if (!closing) await closeTransport();
    throw error;
  }
}

async function decoderSession(page, selector) {
  await expect.poll(async () => {
    const match = (await page.locator(selector).textContent())?.match(/decoder-[A-Za-z0-9-]+/);
    return match?.[0] ?? '';
  }).not.toBe('');
  return (await page.locator(selector).textContent()).match(/decoder-[A-Za-z0-9-]+/)[0];
}

function createOpsReader(phase5Acceptance) {
  if (phase5Acceptance) {
    return async () => {
      const { statusCode, body } = await readCandidateOps('/readyz');
      return { status: statusCode, value: body };
    };
  }
  return () => new Promise((resolveRead, rejectRead) => {
    const request = nodeHttpRequest({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: 8090,
      method: 'GET',
      path: '/readyz',
      headers: { Host: '127.0.0.1:8090' },
      localAddress: '127.0.0.1',
      agent: false,
      setHost: false,
    }, (response) => {
      const chunks = [];
      let receivedBytes = 0;
      response.on('error', rejectRead);
      response.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > 65_536) {
          request.destroy(new Error('LOCAL_OPS_BODY_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolveRead({
            status: response.statusCode,
            value: JSON.parse(Buffer.concat(chunks, receivedBytes).toString('utf8')),
          });
        } catch (error) {
          rejectRead(error);
        }
      });
    });
    request.on('error', rejectRead);
    request.setTimeout(5000, () => request.destroy(new Error('LOCAL_OPS_TIMEOUT')));
    request.end();
  });
}

async function workerAppliedSeq(readOps) {
  const { status, value } = await readOps();
  if (status !== 200 || !Number.isSafeInteger(value?.workerTelemetry?.appliedCommandSeq)) {
    throw new Error('WORKER_APPLIED_SEQUENCE_REQUIRED');
  }
  return value.workerTelemetry.appliedCommandSeq;
}

async function waitForAppliedCommand(readOps, afterSeq, expected, signalRow = null) {
  await expect.poll(async () => {
    const { status, value } = await readOps();
    if (status !== 200 || !Number.isSafeInteger(value?.workerTelemetry?.appliedCommandSeq)) return 0;
    const matched = value.audioCommandAudit?.filter((batch) => batch.commandSeq > afterSeq
      && batch.commands.some((command) => Object.entries(expected)
        .every(([name, expectedValue]) => command[name] === expectedValue)))
      .map((batch) => batch.commandSeq).sort((a, b) => a - b)[0];
    const peaks = value.workerTelemetry.rowMasterContributionPeakAbs;
    const signal = signalRow === null || (Number.isFinite(peaks?.[signalRow])
      && peaks[signalRow] > 1e-7);
    return matched && value.workerTelemetry.appliedCommandSeq >= matched && signal ? matched : 0;
  }).toBeGreaterThan(afterSeq);
  const { value } = await readOps();
  return value.audioCommandAudit.filter((batch) => batch.commandSeq > afterSeq
    && batch.commandSeq <= value.workerTelemetry.appliedCommandSeq
    && batch.commands.some((command) => Object.entries(expected)
      .every(([name, expectedValue]) => command[name] === expectedValue)))
    .map((batch) => batch.commandSeq).sort((a, b) => a - b)[0];
}

function projectReadyEvidence({ status, value }) {
  return {
    status,
    value: {
      audioOwner: value?.audioOwner ?? null,
      phaseGate: value?.phaseGate ?? null,
      runtimeOwner: value?.runtimeOwner ?? null,
      workerIdentity: {
        expected: value?.workerIdentity?.expected ?? null,
        reported: value?.workerIdentity?.reported ?? null,
      },
      workerReady: value?.workerReady ?? null,
    },
  };
}

function createSurfaceTrace(page) {
  const surfaces = Object.fromEntries(['demo', 'tracks', 'new-ui'].map((name) => [name, {
    http: [],
    webSockets: [],
  }]));
  const requestRecords = new WeakMap();
  let activeSurface = null;

  page.on('request', (request) => {
    if (activeSurface === null) return;
    const record = {
      method: request.method(),
      rawUrl: request.url(),
      responseUrl: null,
      responseStatus: null,
      redirectedFrom: request.redirectedFrom()?.url() ?? null,
      redirectedTo: null,
      failureText: null,
    };
    requestRecords.set(request, record);
    surfaces[activeSurface].http.push(record);
  });
  page.on('response', (response) => {
    const record = requestRecords.get(response.request());
    if (!record) return;
    record.responseUrl = response.url();
    record.responseStatus = response.status();
  });
  page.on('requestfinished', (request) => {
    const record = requestRecords.get(request);
    if (record) record.redirectedTo = request.redirectedTo()?.url() ?? null;
  });
  page.on('requestfailed', (request) => {
    const record = requestRecords.get(request);
    if (record) record.failureText = request.failure()?.errorText ?? 'REQUEST_FAILED';
  });
  page.on('websocket', (socket) => {
    if (activeSurface === null) return;
    const record = {
      url: socket.url(),
      lifecycle: ['open'],
      framesSent: 0,
      framesReceived: 0,
      socketError: null,
      closed: false,
    };
    surfaces[activeSurface].webSockets.push(record);
    socket.on('framesent', () => { record.framesSent += 1; });
    socket.on('framereceived', () => { record.framesReceived += 1; });
    socket.on('socketerror', (error) => {
      record.socketError = String(error);
      record.lifecycle.push('error');
    });
    socket.on('close', () => {
      record.closed = true;
      record.lifecycle.push('close');
    });
  });

  return Object.freeze({
    enter(name) {
      if (!Object.hasOwn(surfaces, name)) throw new Error('PHASE5_SURFACE_UNKNOWN');
      if (activeSurface !== null) throw new Error('PHASE5_SURFACE_ALREADY_ACTIVE');
      activeSurface = name;
    },
    leave(name) {
      if (activeSurface !== name) throw new Error('PHASE5_SURFACE_NOT_ACTIVE');
      activeSurface = null;
    },
    get(name) {
      if (!Object.hasOwn(surfaces, name)) throw new Error('PHASE5_SURFACE_UNKNOWN');
      return surfaces[name];
    },
    evidence: () => projectSurfaceTransports(surfaces, {
      candidateOrigin: CANDIDATE_ORIGIN,
      allowedHttpPaths: new Set([...STATIC_PATHS, ...RUNTIME_PATHS]),
      surfaceEntryPaths: SURFACE_ENTRY_PATHS,
    }),
  });
}

async function waitForSurfaceSocketsClosed(trace, surface) {
  await expect.poll(() => trace.get(surface).webSockets
    .filter(({ closed }) => !closed).length).toBe(0);
}

async function assertSurfaceTransport(trace, surface) {
  const evidence = trace.get(surface);
  await expect.poll(() => evidence.http.length > 0
    && evidence.http.every(({ responseStatus, failureText }) => (
      Number.isInteger(responseStatus) || failureText !== null
    ))).toBe(true);
  expect(evidence.http.length).toBeLessThanOrEqual(SURFACE_HTTP_LIMITS[surface]);
  const pathCounts = new Map();
  for (const request of evidence.http) {
    const url = new URL(request.rawUrl);
    const responseUrl = new URL(request.responseUrl);
    expect(request.method, request.rawUrl).toBe('GET');
    expect(request.failureText, request.rawUrl).toBe(null);
    expect(request.responseStatus, request.rawUrl).toBe(200);
    expect(request.responseUrl, request.rawUrl).toBe(request.rawUrl);
    expect(request.redirectedFrom, request.rawUrl).toBe(null);
    expect(request.redirectedTo, request.rawUrl).toBe(null);
    expect(url.username, request.rawUrl).toBe('');
    expect(url.password, request.rawUrl).toBe('');
    expect(responseUrl.username, request.responseUrl).toBe('');
    expect(responseUrl.password, request.responseUrl).toBe('');
    expect(url.search, request.rawUrl).toBe('');
    expect(url.origin, request.rawUrl).toBe(CANDIDATE_ORIGIN);
    expect(STATIC_PATHS.has(url.pathname) || RUNTIME_PATHS.has(url.pathname),
      request.rawUrl).toBe(true);
    pathCounts.set(url.pathname, (pathCounts.get(url.pathname) ?? 0) + 1);
  }
  for (const [path, count] of pathCounts) {
    expect(count, `${surface} repeated HTTP path ${path}`).toBeLessThanOrEqual(2);
  }

  const paths = evidence.webSockets.map(({ url }) => {
    const parsed = new URL(url);
    expect(parsed.origin, url).toBe('ws://127.0.0.1:18090');
    expect(parsed.pathname === '/decoder'
      ? ['', '?split=1'].includes(parsed.search)
      : parsed.search === '', url).toBe(true);
    return `${parsed.pathname}${parsed.search}`;
  }).sort();
  expect(paths).toEqual([...SURFACE_SOCKET_PATHS[surface]].sort());
  for (const socket of evidence.webSockets) {
    expect(socket.socketError, socket.url).toBe(null);
    expect(socket.closed, socket.url).toBe(true);
    expect(socket.lifecycle[0], socket.url).toBe('open');
    expect(socket.lifecycle.at(-1), socket.url).toBe('close');
    expect(socket.framesReceived, socket.url).toBeGreaterThan(0);
  }
}

async function browserCommandCount(page, name) {
  return page.evaluate((commandName) => globalThis.__phase5.commands
    .filter((command) => command.name === commandName).length, name);
}

async function waitForBrowserCommandResult(page, name, afterCount = 0) {
  await expect.poll(() => page.evaluate(({ commandName, skip }) => {
    const commands = globalThis.__phase5.commands
      .filter((command) => command.name === commandName).slice(skip);
    return commands.some(({ result }) => result !== null);
  }, { commandName: name, skip: afterCount })).toBe(true);
  return page.evaluate(({ commandName, skip }) => globalThis.__phase5.commands
    .filter((command) => command.name === commandName).slice(skip)
    .find(({ result }) => result !== null).result, { commandName: name, skip: afterCount });
}

async function waitForPublicOwner(page, voice, owner) {
  await expect.poll(() => page.evaluate(
    (selectedVoice) => globalThis.__phase5.publicOwners[selectedVoice] ?? null,
    voice,
  )).toBe(owner);
  return owner;
}

test('production UI consumes snapshots, PCM, reconnects, and sends intents only', async ({ page }, testInfo) => {
  test.skip(testInfo.config.metadata.phase5Mode !== true,
    'phase5 production profile has its own fixed localhost server');
  const phase5Acceptance = testInfo.config.metadata.phase5Acceptance === true;
  const readOps = createOpsReader(phase5Acceptance);
  const surfaceTrace = createSurfaceTrace(page);
  const disposerScope = createDisposerScope();
  let primaryFailure = null;

  try {
    await page.addInitScript(() => {
      const NativeWebSocket = globalThis.WebSocket;
      const NativeAudioContext = globalThis.AudioContext;
      const NativeWorkletNode = globalThis.AudioWorkletNode;
      globalThis.__phase5 = {
        sockets: [],
        commands: [],
        publicOwners: {},
        binary: 0,
        contexts: 0,
        worklets: 0,
        oscillators: 0,
        bufferSources: 0,
        convolvers: 0,
      };

      function observeSnapshot(frame) {
        let snapshot = null;
        if (frame?.type === 'snapshot') snapshot = frame.snapshot;
        if (frame?.type === 'state.patch' && Array.isArray(frame.patch)) {
          snapshot = frame.patch.find(({ op, path }) => op === 'replace' && path === '')?.value
            ?? null;
        }
        if (!snapshot?.latent || typeof snapshot.latent !== 'object') return;
        for (const [voice, state] of Object.entries(snapshot.latent)) {
          if (typeof state?.owner === 'string') {
            globalThis.__phase5.publicOwners[voice] = state.owner;
          }
        }
      }

      globalThis.WebSocket = class InstrumentedWebSocket extends NativeWebSocket {
        constructor(url, protocols) {
          if (protocols === undefined) super(url);
          else super(url, protocols);
          const record = { url: String(url), socket: this, lifecycle: [], framesSent: 0,
            framesReceived: 0 };
          globalThis.__phase5.sockets.push(record);
          this.addEventListener('open', () => record.lifecycle.push('open'));
          this.addEventListener('close', () => record.lifecycle.push('close'));
          this.addEventListener('error', () => record.lifecycle.push('error'));
          this.addEventListener('message', (event) => {
            record.framesReceived += 1;
            if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
              globalThis.__phase5.binary += 1;
              return;
            }
            let frame;
            try { frame = JSON.parse(event.data); } catch { return; }
            observeSnapshot(frame);
            if (frame?.type !== 'command.result' || typeof frame.commandId !== 'string') return;
            for (let index = globalThis.__phase5.commands.length - 1; index >= 0; index -= 1) {
              const command = globalThis.__phase5.commands[index];
              if (command.commandId !== frame.commandId) continue;
              command.result = {
                commandId: frame.commandId,
                accepted: frame.accepted === true,
                code: frame.code ?? null,
                released: frame.released === true,
              };
              break;
            }
          });
        }

        send(payload) {
          const record = globalThis.__phase5.sockets
            .find(({ socket }) => socket === this);
          if (record) record.framesSent += 1;
          try {
            const frame = JSON.parse(payload);
            if (frame?.type === 'command' && typeof frame.commandId === 'string') {
              globalThis.__phase5.commands.push({
                commandId: frame.commandId,
                name: frame.name,
                result: null,
              });
            }
          } catch {
            // Binary or non-JSON legacy frames are counted but not interpreted.
          }
          return super.send(payload);
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

    const leaseEvidence = {
      schemaVersion: 1,
      kind: 'production-fixed-entry-chromium-lease-evidence',
      sequence: [],
      surfaceLeases: {},
      audibleSpecies: {},
      surfaceTransports: {},
    };

    if (phase5Acceptance) {
      surfaceTrace.enter('demo');
      await page.goto(`${CANDIDATE_ORIGIN}/demo.html`);
      await page.locator('#btn-connect').click();
      await expect(page.locator('#mode')).toContainText('streaming');
      const demoLease = await takeMaintenanceLease(
        await decoderSession(page, '#log'),
        disposerScope.register,
      );
      leaseEvidence.sequence.push('demo');
      for (const [row, species] of ['bass', 'pad', 'lead', 'pluck'].entries()) {
        await page.locator('#voice').selectOption(String(row));
        const beforeSeq = await workerAppliedSeq(readOps);
        const key = page.locator('#keys [data-midi="60"]');
        await key.dispatchEvent('mousedown');
        await page.waitForTimeout(300);
        const appliedSeq = await waitForAppliedCommand(
          readOps, beforeSeq, { type: 'note.on', row }, row,
        );
        const before = await page.evaluate(() => globalThis.__phase5.binary);
        await expect.poll(() => page.evaluate(
          () => globalThis.__phase5.binary,
        )).toBeGreaterThan(before);
        const after = await page.evaluate(() => globalThis.__phase5.binary);
        const peakAbs = (await readOps()).value.workerTelemetry.rowMasterContributionPeakAbs[row];
        await key.dispatchEvent('mouseup');
        const releasedSeq = await waitForAppliedCommand(
          readOps, appliedSeq, { type: 'note.off', row },
        );
        leaseEvidence.audibleSpecies[species] = {
          commandAccepted: true,
          releaseAccepted: true,
          commandSeq: appliedSeq,
          releaseCommandSeq: releasedSeq,
          peakAbs,
          pcmBlocks: after - before,
        };
      }
      const demoReleased = await demoLease.release();
      expect(demoReleased.released).toBe(true);
      leaseEvidence.surfaceLeases.demo = {
        takeAccepted: demoLease.taken.accepted === true,
        releaseAccepted: demoReleased.accepted === true && demoReleased.released === true,
      };
      await page.locator('#btn-disconnect').click();
      await waitForSurfaceSocketsClosed(surfaceTrace, 'demo');
      await assertSurfaceTransport(surfaceTrace, 'demo');
      surfaceTrace.leave('demo');

      surfaceTrace.enter('tracks');
      await page.goto(`${CANDIDATE_ORIGIN}/tracks.html`);
      await page.locator('#start').click();
      await expect(page.locator('#stat')).toContainText('streaming');
      const tracksLease = await takeMaintenanceLease(
        await decoderSession(page, '#stat'),
        disposerScope.register,
      );
      leaseEvidence.sequence.push('tracks');
      for (let row = 0; row < 4; row += 1) await page.locator(`#play${row}`).click();
      const tracksReleased = await tracksLease.release();
      expect(tracksReleased.released).toBe(true);
      leaseEvidence.surfaceLeases.tracks = {
        takeAccepted: tracksLease.taken.accepted === true,
        releaseAccepted: tracksReleased.accepted === true && tracksReleased.released === true,
      };
      await page.locator('#stop').click();
      await waitForSurfaceSocketsClosed(surfaceTrace, 'tracks');
      await assertSurfaceTransport(surfaceTrace, 'tracks');
      surfaceTrace.leave('tracks');
    }

    surfaceTrace.enter('new-ui');
    await page.goto(CANDIDATE_ORIGIN);
    await page.locator('#start-btn').click();
    await expect(page.locator('[data-runtime-status]')).toHaveText('server runtime ready');
    await expect(page.locator('[data-world-generation]')).not.toHaveText('');
    const readyRead = await readOps();
    expect(readyRead.status).toBe(200);
    expect(readyRead.value?.workerReady).toBe(true);
    expect(readyRead.value?.runtimeOwner).toBe('server');
    expect(readyRead.value?.audioOwner).toBe('world');
    const readyEvidence = projectReadyEvidence(readyRead);
    expect(Object.keys(readyEvidence.value).sort()).toEqual([...READY_EVIDENCE_FIELDS]);
    expect(Object.keys(readyEvidence.value.workerIdentity).sort()).toEqual([
      'expected', 'reported',
    ]);
    await testInfo.attach('phase5-runtime-identity', {
      body: Buffer.from(canonicalJson(readyEvidence)),
      contentType: 'application/json',
    });
    await expect.poll(() => page.evaluate(
      () => globalThis.__phase5.binary,
    )).toBeGreaterThanOrEqual(3);
    await expect.poll(() => page.evaluate(() => globalThis.__phase5.worklets)).toBe(1);

    const beforeRevision = Number(await page.locator('[data-revision]').textContent());
    await page.locator('[data-bpm="70"]').dispatchEvent('click');
    await expect.poll(async () => Number(await page.locator('[data-revision]').textContent()))
      .toBeGreaterThan(beforeRevision);

    await page.evaluate(() => {
      globalThis.__phase5.sockets
        .find(({ url }) => url.endsWith('/api/v1/runtime')).socket.close();
    });
    await expect.poll(() => page.evaluate(() => globalThis.__phase5.sockets
      .filter(({ url }) => url.endsWith('/api/v1/runtime')).length)).toBe(2);
    await expect(page.locator('[data-runtime-status]')).toHaveText('server runtime ready');

    await page.evaluate(() => {
      globalThis.__phase5.sockets
        .find(({ url }) => url.endsWith('/api/v1/audio')).socket.close();
    });
    await expect.poll(() => page.evaluate(() => globalThis.__phase5.sockets
      .filter(({ url }) => url.endsWith('/api/v1/audio')).length)).toBe(2);
    await expect.poll(() => page.evaluate(
      () => globalThis.__phase5.binary,
    )).toBeGreaterThanOrEqual(6);

    const controlTakeCount = await browserCommandCount(page, 'control.take');
    await page.locator('[data-open-latent="melody"]').dispatchEvent('click');
    await expect(page.locator('.candidate-latent-roamer')).toBeVisible();
    const newUiTakeResult = await waitForBrowserCommandResult(
      page, 'control.take', controlTakeCount,
    );
    expect(newUiTakeResult.accepted).toBe(true);
    await waitForPublicOwner(page, 'melody', 'USER');
    await expect(page.locator('.candidate-latent-live')).toContainText('melody');

    const newUiTakeSeq = phase5Acceptance ? await workerAppliedSeq(readOps) : null;
    await page.locator('[data-preview="hold"]').dispatchEvent('pointerdown');
    const newUiAppliedSeq = newUiTakeSeq === null ? null
      : await waitForAppliedCommand(
        readOps, newUiTakeSeq, { type: 'preview.start', voice: 'lead' },
      );
    await page.locator('[data-preview="hold"]').dispatchEvent('pointerup');
    const newUiReleasedSeq = newUiAppliedSeq === null ? null
      : await waitForAppliedCommand(
        readOps, newUiAppliedSeq, { type: 'preview.allOff', voice: 'lead' },
      );

    const controlReleaseCount = await browserCommandCount(page, 'control.release');
    await page.locator('[data-latent-close="true"]').dispatchEvent('click');
    await expect(page.locator('.candidate-latent-roamer')).toHaveCount(0);
    const newUiReleaseResult = await waitForBrowserCommandResult(
      page, 'control.release', controlReleaseCount,
    );
    expect(newUiReleaseResult.accepted).toBe(true);
    expect(newUiReleaseResult.released).toBe(true);
    const newUiPublicOwner = await waitForPublicOwner(page, 'melody', 'AGENT');

    if (newUiReleasedSeq !== null) {
      expect(Number.isSafeInteger(newUiAppliedSeq)).toBe(true);
      expect(newUiReleasedSeq).toBeGreaterThan(newUiAppliedSeq);
      expect(newUiPublicOwner).toBe('AGENT');
      leaseEvidence.sequence.push('new-ui');
      leaseEvidence.surfaceLeases['new-ui'] = {
        takeAccepted: newUiTakeResult.accepted === true,
        releaseAccepted: newUiReleaseResult.accepted === true
          && newUiReleaseResult.released === true,
        commandSeq: newUiAppliedSeq,
        releaseCommandSeq: newUiReleasedSeq,
        publicOwnerAfterRelease: newUiPublicOwner,
        controlReleaseCommandId: newUiReleaseResult.commandId,
      };
    }

    const productionSockets = await page.evaluate(() => globalThis.__phase5.sockets
      .map(({ url }) => new URL(url).pathname).sort());
    expect(productionSockets).toEqual([
      '/api/v1/audio', '/api/v1/audio', '/api/v1/runtime', '/api/v1/runtime',
    ]);

    const legacyReadOnly = page.evaluate(() => new Promise((resolve, reject) => {
      const socket = new WebSocket('ws://127.0.0.1:18090/decoder');
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('LEGACY_READ_ONLY_TIMEOUT'));
      }, 5000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({
        type: 'note',
        voice: 0,
        midi: 60,
        velocity: 1,
        durationSeconds: 1,
      })));
      socket.addEventListener('message', (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type !== 'error') return;
        clearTimeout(timer);
        socket.close(1000);
        resolve(frame.code);
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('LEGACY_SOCKET_FAILED'));
      });
    }));
    expect(await legacyReadOnly).toBe('LEGACY_LEASE_REQUIRED');

    const diagnostics = await page.evaluate(() => ({
      ...globalThis.__phase5,
      sockets: globalThis.__phase5.sockets.map(({ url, lifecycle, framesSent,
        framesReceived }) => ({ url, lifecycle, framesSent, framesReceived })),
    }));
    expect(diagnostics.contexts).toBeGreaterThanOrEqual(1);
    expect(diagnostics.oscillators).toBe(0);
    expect(diagnostics.bufferSources).toBe(0);
    expect(diagnostics.convolvers).toBe(0);

    surfaceTrace.leave('new-ui');
    await page.goto('about:blank');
    await waitForSurfaceSocketsClosed(surfaceTrace, 'new-ui');
    await assertSurfaceTransport(surfaceTrace, 'new-ui');

    if (phase5Acceptance) {
      leaseEvidence.surfaceTransports = surfaceTrace.evidence();
      validateLeaseEvidence(leaseEvidence);
      await testInfo.attach('phase5-lease-evidence', {
        body: Buffer.from(canonicalJson(leaseEvidence)),
        contentType: 'application/json',
      });
    }
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await disposerScope.dispose();
    } catch (cleanupError) {
      if (primaryFailure === null) throw cleanupError;
      try { primaryFailure.cleanupFailure = cleanupError; } catch {
        // Preserve the original assertion failure after best-effort diagnostics.
      }
    }
  }
});
