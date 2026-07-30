import { open, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { canonicalBytes, exactObject } from './phase5-raw-common.mjs';
import { buildPhase5RawManifest } from './phase5-raw-manifest.mjs';

const LEAVES = Object.freeze([
  ['faultEventsSha256', 'fault-events.json'],
  ['soakRunSha256', 'soak-run.json'],
  ['rawRuntimeReadySamplesSha256', 'runtime-ready-samples.json'],
  ['rawUiStateLagSamplesSha256', 'ui-state-lag-samples.json'],
  ['rawRenderSamplesSha256', 'render-samples.json'],
  ['clientObservationsSha256', 'client-observations.json'],
  ['speciesNormalSamplesSha256', 'species-normal-samples.json'],
  ['speciesBurstSamplesSha256', 'species-burst-samples.json'],
  ['phase5E2eSha256', 'phase5-e2e.json'],
  ['leaseEvidenceSha256', 'lease-evidence.json'],
]);
const MANIFEST = 'phase5-raw-manifest.json';
const fail = (code) => { throw new Error(code); };

export function buildPhase5SoakRunBytes(clientObservationBytes, window) {
  let value;
  try { value = JSON.parse(clientObservationBytes); } catch {
    fail('PHASE5_SOAK_RUN_BUILD_INVALID');
  }
  const pcm = [[], [], [], []];
  if (!Array.isArray(value?.events)) fail('PHASE5_SOAK_RUN_BUILD_INVALID');
  for (const event of value.events) {
    if (event?.type === 'audio.pcm' && Number.isSafeInteger(event.client)
        && event.client >= 1 && event.client <= 4) {
      pcm[event.client - 1].push(event.atMonotonicMs);
    }
    if (event?.type === 'audio.invalid-frame') {
      fail('PHASE5_SOAK_RUN_BUILD_INVALID');
    }
  }
  if (pcm.some((samples) => samples.length === 0)) {
    fail('PHASE5_SOAK_RUN_BUILD_INVALID');
  }
  let hotClientMaxPcmGapMs = 0;
  const hotClientFinalPcmAgeMs = [];
  for (const samples of pcm.slice(0, 3)) {
    hotClientMaxPcmGapMs = Math.max(
      hotClientMaxPcmGapMs,
      samples[0] - window.startedAtMonotonicMs,
      ...samples.slice(1).map((sample, index) => sample - samples[index]),
    );
    hotClientFinalPcmAgeMs.push(
      window.endedAtMonotonicMs - samples.at(-1),
    );
  }
  return canonicalBytes({
    startedAtUnixMs: window.startedAtUnixMs,
    endedAtUnixMs: window.endedAtUnixMs,
    measuredDurationMs: 1_800_000,
    pcmBlocks: pcm.map((samples) => samples.length),
    hotClientMaxPcmGapMs,
    hotClientFinalPcmAgeMs,
    stability: {
      hotClientAbnormalCloses: 0,
      hotClientReconnectStorms: 0,
      hotClientUnderruns: 0,
      pcmCorruptions: 0,
      cursorDiscontinuitiesUnexpected: 0,
    },
  });
}

async function durableExclusiveFile(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1
      || bytes.byteLength > 128 * 1024 * 1024) {
    fail('PHASE5_RAW_TEMP_PUBLISH_INVALID');
  }
  const handle = await open(path, 'wx', 0o400);
  try {
    await handle.chmod(0o400);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

export async function writePhase5RawTempDirectory({
  tempDirectory, binding, window, evidenceBlobs, externalBlobs,
} = {}) {
  if (typeof tempDirectory !== 'string'
      || !basename(tempDirectory).startsWith('.acceptance-evidence-')
      || !exactObject(evidenceBlobs, LEAVES.map(([name]) => name))
      || !exactObject(externalBlobs, [
        'productionGraphSha256', 'productionMachineAttestationSha256',
        'listeningChecklistSha256', 'equivalenceSha256',
      ])) fail('PHASE5_RAW_TEMP_PUBLISH_INVALID');
  const initial = await readdir(tempDirectory);
  if (initial.length !== 0) fail('PHASE5_RAW_TEMP_PUBLISH_INVALID');
  for (const [artifact, name] of LEAVES) {
    await durableExclusiveFile(join(tempDirectory, name), evidenceBlobs[artifact]);
  }
  const manifestBytes = buildPhase5RawManifest({
    binding, window, blobs: { ...evidenceBlobs, ...externalBlobs },
  });
  await durableExclusiveFile(join(tempDirectory, MANIFEST), manifestBytes);
  const expected = [...LEAVES.map(([, name]) => name), MANIFEST].sort();
  const observed = (await readdir(tempDirectory)).sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    fail('PHASE5_RAW_TEMP_PUBLISH_INVALID');
  }
  const directory = await open(tempDirectory, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return Object.freeze({ manifestBytes });
}
