import { createHash } from 'node:crypto';

import {
  canonicalBytes, exactObject, ownBindingAndWindow, rawFail,
} from './phase5-raw-common.mjs';

const CODE = 'PHASE5_RAW_MANIFEST_BUILDER_INVALID';

export const PHASE5_RAW_ARTIFACTS = Object.freeze([
  Object.freeze(['faultEventsSha256', 'acceptance-evidence/fault-events.json']),
  Object.freeze(['soakRunSha256', 'acceptance-evidence/soak-run.json']),
  Object.freeze(['rawRuntimeReadySamplesSha256',
    'acceptance-evidence/runtime-ready-samples.json']),
  Object.freeze(['rawUiStateLagSamplesSha256',
    'acceptance-evidence/ui-state-lag-samples.json']),
  Object.freeze(['rawRenderSamplesSha256',
    'acceptance-evidence/render-samples.json']),
  Object.freeze(['clientObservationsSha256',
    'acceptance-evidence/client-observations.json']),
  Object.freeze(['speciesNormalSamplesSha256',
    'acceptance-evidence/species-normal-samples.json']),
  Object.freeze(['speciesBurstSamplesSha256',
    'acceptance-evidence/species-burst-samples.json']),
  Object.freeze(['phase5E2eSha256', 'acceptance-evidence/phase5-e2e.json']),
  Object.freeze(['leaseEvidenceSha256', 'acceptance-evidence/lease-evidence.json']),
  Object.freeze(['productionGraphSha256', 'production-graph.json']),
  Object.freeze(['productionMachineAttestationSha256',
    'production-machine-attestation.json']),
  Object.freeze(['listeningChecklistSha256', 'listening-checklist.json']),
  Object.freeze(['equivalenceSha256', 'staging-equivalence.json']),
]);

export function buildPhase5RawManifest({ binding, window, blobs } = {}) {
  const owned = ownBindingAndWindow(binding, window, CODE);
  const names = PHASE5_RAW_ARTIFACTS.map(([artifact]) => artifact);
  if (!exactObject(blobs, names)) rawFail(CODE);
  const artifacts = PHASE5_RAW_ARTIFACTS.map(([artifact, path]) => {
    const bytes = blobs[artifact];
    if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1
        || bytes.byteLength > 128 * 1024 * 1024) rawFail(CODE);
    return {
      artifact,
      path,
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  return canonicalBytes({
    schemaVersion: 2,
    kind: 'isolated-equivalent-spark-phase5-raw-manifest',
    ...owned.binding,
    window: owned.window,
    artifacts,
  });
}
