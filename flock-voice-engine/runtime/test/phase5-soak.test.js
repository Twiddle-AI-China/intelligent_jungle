import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { encodeAudioFrameV1 } from '../src/audio/pcm-v1.js';
import {
  advanceSlowClientSchedule,
  FIXED,
  buildSoakRequestPlan,
  closeSoakMeasurementClients,
  cleanupFailedRun,
  decodePcmFrame,
  nextAbsoluteCadenceAt,
  percentile,
  publishAcceptanceArtifacts,
  requireSlowClientTransport,
  reportFailedRun,
  settleSnapshotProbeFrame,
  speciesRequest,
  validateChromiumEvidence,
  validateFixedOptions,
}
  from '../tools/soak-phase5.mjs';

const soakSource = await readFile(
  new URL('../tools/soak-phase5.mjs', import.meta.url),
  'utf8',
);

function canonicalJsonForTest(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonForTest).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonForTest(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validLeaseEvidence() {
  const http = (entryPath, requestCount) => ({
    entryPath,
    entrySeen: true,
    requestCount,
    getOnly: true,
    status200Only: true,
    candidateOriginOnly: true,
    allowedPathOnly: true,
    directOnly: true,
    failureFree: true,
  });
  const socket = (path, framesSent, framesReceived) => ({
    path,
    lifecycle: ['open', 'close'],
    framesSent,
    framesReceived,
  });
  return {
    schemaVersion: 1,
    kind: 'production-fixed-entry-chromium-lease-evidence',
    sequence: ['demo', 'tracks', 'new-ui'],
    surfaceLeases: {
      demo: { takeAccepted: true, releaseAccepted: true },
      tracks: { takeAccepted: true, releaseAccepted: true },
      'new-ui': {
        takeAccepted: true,
        releaseAccepted: true,
        commandSeq: 9,
        releaseCommandSeq: 10,
        publicOwnerAfterRelease: 'AGENT',
        controlReleaseCommandId: '123e4567-e89b-42d3-a456-426614174000',
      },
    },
    audibleSpecies: {
      bass: {
        commandAccepted: true,
        releaseAccepted: true,
        commandSeq: 1,
        releaseCommandSeq: 2,
        peakAbs: 1e-5,
        pcmBlocks: 1,
      },
      pad: {
        commandAccepted: true,
        releaseAccepted: true,
        commandSeq: 3,
        releaseCommandSeq: 4,
        peakAbs: 0.2,
        pcmBlocks: 2,
      },
      lead: {
        commandAccepted: true,
        releaseAccepted: true,
        commandSeq: 5,
        releaseCommandSeq: 6,
        peakAbs: 0.3,
        pcmBlocks: 3,
      },
      pluck: {
        commandAccepted: true,
        releaseAccepted: true,
        commandSeq: 7,
        releaseCommandSeq: 8,
        peakAbs: 1e20,
        pcmBlocks: 4,
      },
    },
    surfaceTransports: {
      demo: {
        http: http('/demo.html', 2),
        webSockets: [socket('/decoder', 1, 3)],
      },
      tracks: {
        http: http('/tracks.html', 3),
        webSockets: [socket('/decoder?split=1', 1, 4)],
      },
      'new-ui': {
        http: http('/', 4),
        webSockets: [
          socket('/api/v1/audio', 0, 2),
          socket('/api/v1/audio', 1, 3),
          socket('/api/v1/runtime', 0, 4),
          socket('/api/v1/runtime', 2, 5),
          socket('/decoder', 1, 1),
        ],
      },
    },
  };
}

function validReadyEvidence() {
  return {
    status: 200,
    value: {
      workerReady: true,
      runtimeOwner: 'server',
      audioOwner: 'world',
      phaseGate: 'phase5-local',
      workerIdentity: { expected: null, reported: null },
    },
  };
}

function validChromiumReport() {
  const ready = validReadyEvidence();
  const lease = validLeaseEvidence();
  return {
    lease,
    report: {
      config: {
        configFile: '/release/playwright.phase5-acceptance.config.js',
        metadata: {
          phase5Mode: true,
          phase5Acceptance: true,
          surfaceProfile: 'production-fixed-entry',
        },
        projects: [{ name: 'chromium' }],
      },
      suites: [{
        file: 'phase5-local.spec.js',
        specs: [{
          ok: true,
          tests: [{
            projectName: 'chromium',
            status: 'expected',
            results: [{
              status: 'passed',
              attachments: [{
                name: 'phase5-runtime-identity',
                contentType: 'application/json',
                body: Buffer.from(canonicalJsonForTest(ready)).toString('base64'),
              }, {
                name: 'phase5-lease-evidence',
                contentType: 'application/json',
                body: Buffer.from(canonicalJsonForTest(lease)).toString('base64'),
              }],
            }],
          }],
        }],
      }],
      stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 },
    },
  };
}

function attachment(report, name) {
  return report.suites[0].specs[0].tests[0].results[0].attachments
    .find((item) => item.name === name);
}

function setAttachmentBytes(report, name, bytes) {
  attachment(report, name).body = Buffer.from(bytes).toString('base64');
}

function assertProductionEvidenceRejected(report) {
  assert.throws(
    () => validateChromiumEvidence(report),
    /PHASE5_PRODUCTION_E2E_REQUIRED/,
  );
}

test('soak profile is fixed to four clients, one slow reader and thirty minutes', () => {
  const options = { baseUrl: 'http://127.0.0.1:18090', ...FIXED,
    output: '/tmp/acceptance.json' };
  assert.equal(validateFixedOptions(options), true);
  for (const [name, value] of [['clients', 3], ['slowClient', 3], ['durationMinutes', 29.99],
    ['surfaceProfile', 'shadow-fixture'], ['speciesModel', 'other']]) {
    assert.throws(() => validateFixedOptions({ ...options, [name]: value }),
      /EQUIVALENT_STAGING_PROFILE_REQUIRED/);
  }
  assert.throws(() => validateFixedOptions({ ...options, baseUrl: 'http://192.168.9.140:8090' }),
    /LOOPBACK_CANDIDATE_URL_REQUIRED/);
});

test('v2 soak is raw-only and delegates the sole controller command exactly', () => {
  const forbidden = [
    /capture_machine_attestation\.py/u,
    /advanceSlowClientSchedule/u,
    /stagingAttestation/u,
    /stagingEvidence/u,
    /phase5-summary\.json/u,
    /publishAcceptanceArtifacts/u,
    /schemaVersion:\s*1,\s*status:\s*['"]accepted['"]/u,
    /rm\([^\n]*(?:acceptance\.json|phase5-summary|staging-machine)/u,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(soakSource, pattern);
  }
  assert.match(
    soakSource,
    /capture-and-attest-local['"],\s*['"]--release-dir['"],\s*[^,\]]+\]/u,
  );
  assert.doesNotMatch(
    soakSource,
    /capture-and-attest-local[\s\S]{0,300}(?:--output|--role|--session|--runner|--verifier)/u,
  );
});

test('legacy publisher has no authority over protected controller outputs', async () => {
  const protectedNames = [
    'acceptance.json',
    'phase5-summary.json',
    'staging-machine-attestation.json',
    'staging-machine-attestation.evidence',
    'production-graph.json',
    'production-machine-attestation.json',
    'listening-checklist.json',
    'staging-equivalence.json',
  ];
  const operations = [];
  const paths = {
    temporaryEvidence: '/release/.phase5-raw-private',
    evidenceRoot: '/release/acceptance-evidence',
    output: '/release/acceptance.json',
    stagingAttestation: '/release/staging-machine-attestation.json',
    stagingEvidence: '/release/staging-machine-attestation.evidence',
  };
  try {
    await publishAcceptanceArtifacts(paths, {}, {
      renameImpl: async (from, to) => operations.push(['rename', from, to]),
      writeFileImpl: async (path) => operations.push(['write', path]),
      rmImpl: async (path) => operations.push(['rm', path]),
    });
  } catch {
    // The boundary is evaluated from attempted side effects, not return status.
  }
  for (const operation of operations) {
    const targets = operation.slice(1).join('\0');
    for (const name of protectedNames) {
      assert.equal(targets.includes(name), false, `${operation[0]}:${name}`);
    }
  }
});

test('soak separates exact candidate browser requests from internal loopback ops probes', () => {
  const options = { baseUrl: 'http://127.0.0.1:18090', ...FIXED,
    output: '/tmp/acceptance.json' };
  const plan = buildSoakRequestPlan(options);

  assert.deepEqual(plan, {
    browserOrigin: 'http://127.0.0.1:18090',
    bootstrapUrl: 'http://127.0.0.1:18090/api/v1/bootstrap',
    runtimeUrl: 'ws://127.0.0.1:18090/api/v1/runtime',
    audioUrl: 'ws://127.0.0.1:18090/api/v1/audio',
    opsPath: '/readyz',
    opsReader: 'docker-exec:flock-runtime-candidate',
    browserHttpHeaders: { origin: 'http://127.0.0.1:18090' },
    browserWebSocketOptions: { origin: 'http://127.0.0.1:18090' },
  });
  assert.equal(JSON.stringify(plan).includes('4193'), false);
});

test('slow-client transport cannot silently skip pause or resume', () => {
  assert.throws(() => requireSlowClientTransport({}), /SLOW_CLIENT_BACKPRESSURE_UNAVAILABLE/);
  assert.throws(() => requireSlowClientTransport({ _socket: { pause() {} } }),
    /SLOW_CLIENT_BACKPRESSURE_UNAVAILABLE/);
  const calls = [];
  let paused = false;
  const transport = requireSlowClientTransport({
    _socket: {
      isPaused() { return paused; },
      pause() { calls.push('pause'); paused = true; },
      resume() { calls.push('resume'); paused = false; },
    },
  });
  transport.pause();
  transport.resume();
  assert.deepEqual(calls, ['pause', 'resume']);
  assert.equal(transport.isPaused(), false);

  const noOp = requireSlowClientTransport({
    _socket: {
      isPaused: () => false,
      pause() {},
      resume() {},
    },
  });
  assert.throws(() => noOp.pause(), /SLOW_CLIENT_BACKPRESSURE_UNAVAILABLE/);
  assert.doesNotMatch(soakSource, /_socket\?\./);
});

test('slow-client schedule is non-blocking and preserves 250ms measurement cadence', () => {
  const calls = [];
  let paused = false;
  const controller = {
    isPaused: () => paused,
    pause() { assert.equal(paused, false); paused = true; calls.push(['pause', now]); },
    resume() { assert.equal(paused, true); paused = false; calls.push(['resume', now]); },
  };
  const schedule = { nextPauseAtMs: 5000, resumeAtMs: null };
  let samples = 0;
  let now = 0;
  for (; now <= 20_000; now += 250) {
    advanceSlowClientSchedule(schedule, controller, now);
    samples += 1;
  }
  assert.equal(samples, 81);
  assert.deepEqual(calls, [
    ['pause', 5000], ['resume', 7000],
    ['pause', 10_000], ['resume', 12_000],
    ['pause', 15_000], ['resume', 17_000],
    ['pause', 20_000],
  ]);
  controller.resume();
  assert.equal(paused, false);
  assert.match(
    soakSource,
    /advanceSlowClientSchedule\(slowClientSchedule,\s*slowClientTransport,\s*now\)/,
  );
  assert.doesNotMatch(soakSource, /await sleep\(2000\)/);
});

test('absolute telemetry cadence absorbs 50ms polling cost over thirty minutes', () => {
  const durationMs = 30 * 60_000;
  let now = 0;
  let nextTelemetryAt = 0;
  let samples = 0;
  while (now < durationMs) {
    assert.equal(now >= nextTelemetryAt, true);
    samples += 1;
    now += 50;
    nextTelemetryAt = nextAbsoluteCadenceAt(nextTelemetryAt, now, 250);
    now = nextTelemetryAt;
  }

  assert.equal(samples, 7200);
  assert.equal(samples >= Math.floor(durationMs / 250 * 0.90), true);
  assert.match(
    soakSource,
    /nextTelemetryAt\s*=\s*nextAbsoluteCadenceAt\(\s*nextTelemetryAt,\s*afterPoll,\s*250\s*\)/,
  );
  assert.doesNotMatch(soakSource, /await pollTelemetry\([^;]+;\s*await sleep\(250\)/);
});

test('measurement cleanup resumes the slow reader and closes every socket', () => {
  let paused = true;
  const closed = [];
  const clients = [1, 2, 3, 4].map((number) => ({
    runtime: { close: (code) => closed.push(`${number}:runtime:${code}`) },
    audio: { close: (code) => closed.push(`${number}:audio:${code}`) },
  }));
  const metrics = { stopping: false };
  const transport = {
    isPaused: () => paused,
    resume() { paused = false; },
  };

  closeSoakMeasurementClients(clients, metrics, transport);

  assert.equal(metrics.stopping, true);
  assert.equal(paused, false);
  assert.deepEqual(closed, [
    '1:runtime:1000', '1:audio:1000',
    '2:runtime:1000', '2:audio:1000',
    '3:runtime:1000', '3:audio:1000',
    '4:runtime:1000', '4:audio:1000',
  ]);
  assert.match(soakSource, /finally\s*\{[\s\S]*closeSoakMeasurementClients\(/);
});

test('species shared-load rejects malformed HTTP 200 responses', async () => {
  const metrics = {
    measurementStarted: 0,
    species: { normal: [], burst: [] },
    speciesErrors: 0,
  };
  let now = 100;
  const response = (value, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  });
  const requests = [];
  const run = (value, status = 200) => speciesRequest(
    'http://127.0.0.1:8081/v1',
    'bird_agent',
    'normal',
    metrics,
    { fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return response(value, status);
    }, nowImpl: () => (now += 10) },
  );

  await run({ choices: [] });
  assert.equal(metrics.speciesErrors, 1);
  assert.equal(metrics.species.normal.at(-1).ok, false);

  await run({ choices: { 0: { message: { content: '{"ok":true}' } } } });
  await run({ choices: [{ message: { content: '{"ok":true}' } }] }, 201);
  await run({ choices: [{ message: { content: 'not-json' } }] });
  await run({ choices: [{ message: { content: '{"ok":false}' } }] });
  await run({ choices: [{ message: { content: '{}' } }] });
  assert.equal(metrics.speciesErrors, 6);
  assert.equal(metrics.species.normal.at(-1).ok, false);

  await run({ choices: [{ message: { content: '{"ok":false,"ok":true}' } }] });
  await run(Object.create({
    choices: [{ message: { content: '{"ok":true}' } }],
  }));
  await run({ choices: [Object.create({
    message: { content: '{"ok":true}' },
  })] });
  await run({ choices: [{ message: Object.create({
    content: '{"ok":true}',
  }) }] });
  assert.equal(metrics.speciesErrors, 10);
  assert.equal(metrics.species.normal.at(-1).ok, false);

  Object.prototype.ok = true;
  try {
    await run({ choices: [{ message: { content: '{"unexpected":1}' } }] });
  } finally {
    delete Object.prototype.ok;
  }
  assert.equal(metrics.speciesErrors, 11);
  assert.equal(metrics.species.normal.at(-1).ok, false);

  await run({ choices: [{ message: { content: '{"ok":true}' } }] });
  assert.equal(metrics.speciesErrors, 11);
  assert.equal(metrics.species.normal.at(-1).ok, true);
  assert.deepEqual(requests.at(-1).response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'flock_health_token',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { const: true } },
      },
    },
  });

  await speciesRequest(
    'http://127.0.0.1:8081/v1',
    'bird_agent',
    'normal',
    metrics,
    { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }),
      nowImpl: () => (now += 10) },
  );
  assert.equal(metrics.speciesErrors, 12);
  assert.equal(metrics.species.normal.at(-1).ok, false);
});

test('snapshot probe latency settles from the authoritative snapshot barrier in FIFO order', () => {
  const state = {
    pending: new Map([
      ['probe-1', 10],
      ['probe-2', 20],
    ]),
  };
  const metrics = {
    measurementStarted: 5,
    uiStateLagSamples: [],
    uiProbeFailures: 0,
  };

  assert.equal(settleSnapshotProbeFrame(
    state, { type: 'snapshot', revision: 7 }, metrics, 30,
  ), true);
  assert.deepEqual([...state.pending.keys()], ['probe-2']);
  assert.deepEqual(metrics.uiStateLagSamples, [{
    atMs: 25,
    latencyMs: 20,
  }]);

  assert.equal(settleSnapshotProbeFrame(state, {
    type: 'command.result',
    commandId: 'probe-2',
    accepted: false,
    code: 'INVALID_COMMAND',
  }, metrics, 35), false);
  assert.equal(state.pending.size, 0);
  assert.equal(metrics.uiStateLagSamples.length, 1);
  assert.equal(metrics.uiProbeFailures, 1);
  assert.equal(settleSnapshotProbeFrame(
    state, { type: 'domain.event' }, metrics, 40,
  ), false);
});

test('snapshot replies outside the frozen measurement window cannot inflate evidence', () => {
  const state = { pending: new Map([['probe-1', 10]]) };
  const metrics = {
    measurementStarted: 0,
    measurementDeadline: 25,
    measurementEnded: 25,
    uiStateLagSamples: [],
    uiProbeFailures: 0,
  };

  assert.equal(settleSnapshotProbeFrame(
    state, { type: 'snapshot', revision: 7 }, metrics, 26,
  ), false);
  assert.equal(state.pending.size, 0);
  assert.deepEqual(metrics.uiStateLagSamples, []);
  assert.equal(metrics.uiProbeFailures, 1);
});

test('failed-run cleanup never deletes an unvalidated caller attestation path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flock-soak-cleanup-'));
  const victim = join(root, 'caller-owned-attestation.json');
  const outputRoot = join(root, 'output');
  const temporary = join(outputRoot, `.acceptance-evidence-${process.pid}`);
  await mkdir(temporary, { recursive: true });
  await writeFile(victim, 'caller-owned');
  try {
    await cleanupFailedRun({
      output: join(outputRoot, 'acceptance.json'),
      stagingAttestation: victim,
    });
    assert.equal(await readFile(victim, 'utf8'), 'caller-owned');
    await access(temporary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('atomic publication cleanup removes only artifacts this run actually published', async () => {
  const paths = {
    temporaryEvidence: 'temporary-evidence',
    evidenceRoot: 'published-evidence',
    output: 'acceptance.json',
    stagingAttestation: 'staging.json',
    stagingEvidence: 'staging.evidence',
  };
  const renameFailureRemovals = [];
  await assert.rejects(publishAcceptanceArtifacts(paths, {}, {
    renameImpl: async () => { throw new Error('EEXIST'); },
    writeFileImpl: async () => { throw new Error('must not write'); },
    rmImpl: async (path, options) => {
      renameFailureRemovals.push({ path, options });
    },
  }), /EEXIST/);
  assert.equal(renameFailureRemovals.some(({ path }) => path === paths.evidenceRoot), false);
  assert.equal(renameFailureRemovals.some(({ path }) => path === paths.output), false);

  const outputRaceRemovals = [];
  await assert.rejects(publishAcceptanceArtifacts(paths, {}, {
    renameImpl: async () => {},
    writeFileImpl: async () => { throw new Error('EEXIST'); },
    rmImpl: async (path, options) => {
      outputRaceRemovals.push({ path, options });
    },
  }), /EEXIST/);
  assert.equal(outputRaceRemovals.some(({ path }) => path === paths.evidenceRoot), true);
  assert.equal(outputRaceRemovals.some(({ path }) => path === paths.output), false);
});

test('publication cleanup is best-effort and preserves the original publish failure', async () => {
  const paths = {
    temporaryEvidence: 'temporary-evidence',
    evidenceRoot: 'published-evidence',
    output: 'acceptance.json',
    stagingAttestation: 'staging.json',
    stagingEvidence: 'staging.evidence',
  };
  const publishError = new Error('OUTPUT_PUBLISH_FAILED');
  const cleanupError = new Error('TEMPORARY_CLEANUP_FAILED');
  const cleanupAttempts = [];
  let rejection;

  await assert.rejects(publishAcceptanceArtifacts(paths, {}, {
    renameImpl: async () => {},
    writeFileImpl: async () => { throw publishError; },
    rmImpl: async (path, options) => {
      if (options?.force !== true) return;
      cleanupAttempts.push(path);
      if (path === paths.temporaryEvidence) throw cleanupError;
    },
  }), (error) => {
    rejection = error;
    return true;
  });

  const reportedErrors = rejection instanceof AggregateError
    ? rejection.errors
    : [rejection];
  assert.equal(reportedErrors.includes(publishError), true);
  assert.equal(reportedErrors.includes(cleanupError), true);
  assert.deepEqual(cleanupAttempts, [
    paths.temporaryEvidence,
    paths.evidenceRoot,
    paths.stagingAttestation,
    paths.stagingEvidence,
  ]);
  assert.equal(cleanupAttempts.includes(paths.output), false);
});

test('CLI failure reporting preserves the run error when failed-run cleanup throws', async () => {
  const runError = new Error('SOAK_RUN_FAILED');
  const cleanupError = new Error('FAILED_RUN_CLEANUP_FAILED');
  const stderr = [];
  let exitCode = null;

  await reportFailedRun({}, runError, {
    cleanupImpl: async () => { throw cleanupError; },
    writeStderrImpl: (message) => stderr.push(message),
    setExitCodeImpl: (value) => { exitCode = value; },
  });

  assert.equal(stderr[0], 'SOAK_RUN_FAILED\n');
  assert.equal(stderr.some((message) => message.includes('FAILED_RUN_CLEANUP_FAILED')), true);
  assert.equal(exitCode, 2);
});

test('raw nearest-rank percentiles remain independently recomputable', () => {
  assert.equal(percentile([5, 1, 4, 2, 3], .95), 5);
  assert.equal(percentile([5, 1, 4, 2, 3], .50), 3);
  assert.throws(() => percentile([], .95), /PERCENTILE_SAMPLES_REQUIRED/);
});

test('soak PCM parser rejects corrupt protocol, payload and cursor evidence', () => {
  const frame = encodeAudioFrameV1({ streamRevision: 2, blockSeq: 3, startFrame: 10n,
    frameCount: 2, channels: 2, format: 1 }, new Float32Array([.1, .2, .3, .4]));
  assert.deepEqual(decodePcmFrame(frame, { revision: 2, sequence: 3, startFrame: 10n }),
    { revision: 2, sequence: 4, startFrame: 12n });
  const badMagic = Buffer.from(frame); badMagic[0] = 0;
  assert.throws(() => decodePcmFrame(badMagic), /PCM_FRAME_HEADER_INVALID/);
  assert.throws(() => decodePcmFrame(frame.subarray(0, -4)), /PCM_FRAME_LENGTH_INVALID/);
  const nan = Buffer.from(frame); nan.writeFloatLE(Number.NaN, 32);
  assert.throws(() => decodePcmFrame(nan), /PCM_SAMPLE_INVALID/);
  assert.throws(() => decodePcmFrame(frame,
    { revision: 2, sequence: 4, startFrame: 10n }), /PCM_CURSOR_DISCONTINUITY/);
});

test('only an exact Chromium phase5 production-entry report returns lease evidence', () => {
  const { report, lease } = validChromiumReport();
  assert.deepEqual(validateChromiumEvidence(report), lease);
});

test('Chromium evidence rejects non-production project and failed stats', () => {
  const { report } = validChromiumReport();
  const wrongProject = structuredClone(report);
  wrongProject.config.projects[0].name = 'fake';
  assertProductionEvidenceRejected(wrongProject);
  const failedStats = structuredClone(report);
  failedStats.stats.unexpected = 1;
  assertProductionEvidenceRejected(failedStats);
});

test('Chromium evidence rejects broad ready evidence', () => {
  const { report } = validChromiumReport();
  const ready = validReadyEvidence();
  ready.value.unprojectedDiagnostic = 'must-not-persist';
  setAttachmentBytes(report, 'phase5-runtime-identity', canonicalJsonForTest(ready));
  assertProductionEvidenceRejected(report);
});

test('Chromium evidence rejects a canonical lease with an extra top-level token', () => {
  const { report, lease } = validChromiumReport();
  lease.maintenanceToken = 'must-not-persist';
  setAttachmentBytes(report, 'phase5-lease-evidence', canonicalJsonForTest(lease));
  assertProductionEvidenceRejected(report);
});

test('Chromium evidence rejects non-canonical base64', () => {
  const { report } = validChromiumReport();
  attachment(report, 'phase5-lease-evidence').body += '\n';
  assertProductionEvidenceRejected(report);
});

test('Chromium evidence rejects invalid UTF-8 attachment bytes', () => {
  const { report } = validChromiumReport();
  setAttachmentBytes(report, 'phase5-lease-evidence', Buffer.from([0xc3, 0x28]));
  assertProductionEvidenceRejected(report);
});

test('Chromium evidence rejects duplicate JSON object members', () => {
  const { report, lease } = validChromiumReport();
  const duplicate = canonicalJsonForTest(lease).replace(/^\{/, '{"kind":"hidden-secret",');
  setAttachmentBytes(report, 'phase5-lease-evidence', duplicate);
  assertProductionEvidenceRejected(report);
});

test('Chromium evidence rejects non-canonical JS number spelling', () => {
  const { report, lease } = validChromiumReport();
  const nonCanonical = canonicalJsonForTest(lease)
    .replace('"peakAbs":0.00001', '"peakAbs":1e-5');
  assert.notEqual(nonCanonical, canonicalJsonForTest(lease));
  setAttachmentBytes(report, 'phase5-lease-evidence', nonCanonical);
  assertProductionEvidenceRejected(report);
});

test('Chromium evidence requires canonical JSON bytes for ready attachment too', () => {
  const { report } = validChromiumReport();
  setAttachmentBytes(report, 'phase5-runtime-identity', JSON.stringify(validReadyEvidence()));
  assertProductionEvidenceRejected(report);
});

test('soak run reuses the returned validated lease without reparsing the attachment', () => {
  assert.match(soakSource, /const lease\s*=\s*validateChromiumEvidence\(/);
  assert.doesNotMatch(soakSource, /const leaseAttachment\s*=\s*e2e\.config/);
});
