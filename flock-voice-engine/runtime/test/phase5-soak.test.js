import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeAudioFrameV1 } from '../src/audio/pcm-v1.js';
import { FIXED, decodePcmFrame, percentile, validateChromiumEvidence, validateFixedOptions }
  from '../tools/soak-phase5.mjs';

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

test('only a real Chromium phase5 production-entry report is evidence', () => {
  const ready = { status: 200, value: { workerReady: true, runtimeOwner: 'server',
    audioOwner: 'world', phaseGate: 'phase5-local', workerIdentity: { expected: null, reported: null } } };
  const lease = { schemaVersion: 1, kind: 'production-fixed-entry-chromium-lease-evidence',
    sequence: ['demo', 'tracks', 'new-ui'], surfaceLeases: Object.fromEntries(
      ['demo', 'tracks', 'new-ui'].map((name) => [name,
        { takeAccepted: true, releaseAccepted: true }])), audibleSpecies: {} };
  const valid = { config: { configFile: '/release/playwright.phase5-acceptance.config.js',
    metadata: { phase5Mode: true, phase5Acceptance: true,
      surfaceProfile: 'production-fixed-entry' }, projects: [{ name: 'chromium' }] },
  suites: [{ file: 'phase5-local.spec.js', specs: [{ ok: true, tests: [{ projectName: 'chromium',
    status: 'expected', results: [{ status: 'passed', attachments: [{
      name: 'phase5-runtime-identity', contentType: 'application/json',
      body: Buffer.from(JSON.stringify(ready)).toString('base64') }, {
      name: 'phase5-lease-evidence', contentType: 'application/json',
      body: Buffer.from(JSON.stringify(lease)).toString('base64') }] }] }] }] }],
  stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 } };
  validateChromiumEvidence(valid);
  assert.throws(() => validateChromiumEvidence({ ...valid, config: { projects: [{ name: 'fake' }] } }),
    /PHASE5_PRODUCTION_E2E_REQUIRED/);
  assert.throws(() => validateChromiumEvidence({ ...valid, stats: { expected: 1, unexpected: 1 } }),
    /PHASE5_PRODUCTION_E2E_REQUIRED/);
});
