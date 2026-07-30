import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, parse, resolve, sep } from 'node:path';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;
const DEPLOY_EXECUTION_NAMES = Object.freeze([
  'release.sh',
  'release_control.py',
  'phase5_candidate_attempt.py',
  'phase5_candidate_bootstrap.py',
  'verify-smoke.mjs',
  'verify-candidate.sh',
  'legacy-lease.mjs',
  'prepare-cutover-request.mjs',
  'validate_phase5_acceptance.py',
  'acceptance.schema.json',
  'machine-attestation.schema.json',
  'phase5-fault-verifier/verify-phase5-fault-evidence.mjs',
  'phase5-fault-verifier/verify-phase5-capture-proof.mjs',
  'phase5-fault-verifier/lib/phase5-fault-evidence.mjs',
  'phase5-fault-verifier/lib/phase5-fault-validation.mjs',
  'phase5-fault-verifier/lib/phase5-fault-transport-projection.mjs',
  'phase5-fault-verifier/lib/phase5-fault-semantics.mjs',
  'src/capture/phase5-capture-proof.js',
  'src/capture/capture-wire.js',
  'phase5-summary/phase5-summary.schema.json',
  'phase5-summary/soak-phase5.mjs',
  'phase5-summary/lib/candidate-ops.mjs',
  'phase5-summary/lib/phase5-client-observation-recorder.mjs',
  'phase5-summary/lib/phase5-controller-session-client.mjs',
  'phase5-summary/lib/phase5-fault-control-client.mjs',
  'phase5-summary/lib/phase5-fault-evidence.mjs',
  'phase5-summary/lib/phase5-fault-semantics.mjs',
  'phase5-summary/lib/phase5-fault-transport-projection.mjs',
  'phase5-summary/lib/phase5-latency-recorder.mjs',
  'phase5-summary/lib/phase5-lease-evidence.mjs',
  'phase5-summary/lib/phase5-raw-bundle.mjs',
  'phase5-summary/lib/phase5-raw-common.mjs',
  'phase5-summary/lib/phase5-raw-manifest.mjs',
  'phase5-summary/lib/phase5-render-recorder.mjs',
  'phase5-summary/lib/phase5-soak-clients.mjs',
  'phase5-summary/lib/phase5-soak-orchestrator.mjs',
  'phase5-summary/lib/phase5-soak-sampling.mjs',
  'phase5-summary/lib/phase5-species-raw-recorder.mjs',
  'src/acceptance/phase5-fault-control-protocol.js',
  'phase5-summary/capture_machine_attestation.py',
  'phase5-summary/phase5_capture_channel_client.py',
]);

function fail(reason, cause) {
  const error = new Error(reason, cause ? { cause } : undefined);
  error.code = reason;
  throw error;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sameStat(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

function sameIdentity(before, after) {
  return before.dev === after.dev && before.ino === after.ino;
}

function validateStat(value) {
  const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : value.uid;
  if (!value.isFile() || (value.uid !== 0 && value.uid !== effectiveUid) || (value.mode & 0o022) !== 0) {
    fail('RELEASE_MANIFEST_UNTRUSTED_PATH');
  }
}

function validateDirectoryStat(value) {
  const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : value.uid;
  if (!value.isDirectory() || (value.uid !== 0 && value.uid !== effectiveUid) || (value.mode & 0o022) !== 0) {
    fail('RELEASE_MANIFEST_UNTRUSTED_PATH');
  }
}

async function inspectAncestors(path, fdReader) {
  if (typeof fdReader.lstat !== 'function') return [];
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = dirname(absolute).slice(root.length).split(sep).filter(Boolean);
  const snapshots = [];
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    const value = await fdReader.lstat(current);
    if (value.isSymbolicLink()) fail('RELEASE_MANIFEST_UNTRUSTED_PATH');
    validateDirectoryStat(value);
    snapshots.push({ path: current, value });
  }
  return snapshots;
}

async function assertAncestorsUnchanged(snapshots, fdReader) {
  for (const snapshot of snapshots) {
    const current = await fdReader.lstat(snapshot.path);
    // Sibling creation legitimately changes an ancestor directory's size/mtime.
    // Path substitution is prevented by stable device/inode identity; the
    // trusted parent itself is separately anchored and compared in full.
    if (current.isSymbolicLink() || !sameIdentity(snapshot.value, current)) {
      fail('RELEASE_MANIFEST_CHANGED_DURING_READ');
    }
    validateDirectoryStat(current);
  }
}

async function readStable(path, fdReader) {
  let handle;
  try {
    handle = await fdReader.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    validateStat(before);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameStat(before, after)) fail('RELEASE_MANIFEST_CHANGED_DURING_READ');
    return bytes;
  } catch (error) {
    if (error?.code?.startsWith?.('RELEASE_MANIFEST_')) throw error;
    fail('RELEASE_MANIFEST_UNTRUSTED_PATH', error);
  } finally {
    await handle?.close?.();
  }
}

function validateIdentity(value) {
  if (!value || typeof value !== 'object'
      || !HEX40.test(value.releaseRevision)
      || !HEX64.test(value.sourceManifestSha256)
      || value.protocolFamily !== 'flock-audio-ipc'
      || value.protocolVersion !== 1
      || value.audioArtifactKind !== 'release-artifact'
      || !HEX64.test(value.audioArtifactSha256)
      || Object.keys(value).sort().join(',') !== [
        'audioArtifactKind', 'audioArtifactSha256', 'protocolFamily', 'protocolVersion',
        'releaseRevision', 'sourceManifestSha256',
      ].sort().join(',')) {
    fail('RELEASE_MANIFEST_SCHEMA_INVALID');
  }
}

function validateManifest(value) {
  const requiredKeys = [
    'schemaVersion', 'workerIdentity', 'geometry', 'manifestGeometrySha256',
    'baseImages', 'imageIdentity',
  ];
  const optionalKeys = ['bootstrapSha256', 'deployExecutionIdentity',
    'deployReleaseScriptSha256', 'localImageDiagnostics', 'productionGraphSha256'];
  const keys = Object.keys(value ?? {});
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== 1
      || requiredKeys.some((key) => !keys.includes(key))
      || keys.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))) {
    fail('RELEASE_MANIFEST_SCHEMA_INVALID');
  }
  validateIdentity(value.workerIdentity);
  const geometry = value.geometry;
  if (!geometry || !Number.isSafeInteger(geometry.sampleRate) || geometry.sampleRate <= 0
      || !Number.isSafeInteger(geometry.blockFrames) || geometry.blockFrames <= 0
      || !Number.isSafeInteger(geometry.poolSize) || geometry.poolSize <= 0
      || !Array.isArray(geometry.rowVoices)
      || geometry.rowVoices.length !== geometry.poolSize
      || geometry.rowVoices.some((voice) => typeof voice !== 'string' || voice.length === 0)) {
    fail('RELEASE_MANIFEST_GEOMETRY_INVALID');
  }
  const geometrySha = createHash('sha256').update(canonicalJson(geometry)).digest('hex');
  if (value.manifestGeometrySha256 !== geometrySha) fail('RELEASE_MANIFEST_GEOMETRY_DIGEST_MISMATCH');
  for (const key of ['runtime', 'audio']) {
    if (!value.baseImages?.[key]?.repository || !OCI_DIGEST.test(value.baseImages[key].digest)
        || !OCI_DIGEST.test(value.imageIdentity?.[key])) {
      fail('RELEASE_MANIFEST_IMAGE_IDENTITY_INVALID');
    }
  }
  if (value.bootstrapSha256 !== undefined && !HEX64.test(value.bootstrapSha256)) {
    fail('RELEASE_MANIFEST_BOOTSTRAP_IDENTITY_INVALID');
  }
  if (value.productionGraphSha256 !== undefined && !HEX64.test(value.productionGraphSha256)) {
    fail('RELEASE_MANIFEST_PRODUCTION_GRAPH_IDENTITY_INVALID');
  }
  if (value.deployReleaseScriptSha256 !== undefined
      && !HEX64.test(value.deployReleaseScriptSha256)) {
    fail('RELEASE_MANIFEST_SCRIPT_IDENTITY_INVALID');
  }
  if (value.deployExecutionIdentity !== undefined) {
    const identity = value.deployExecutionIdentity;
    if (!identity
        || Object.keys(identity).length !== DEPLOY_EXECUTION_NAMES.length
        || DEPLOY_EXECUTION_NAMES.some((name) => (
          !Object.hasOwn(identity, name)
          || !HEX64.test(identity[name])
        ))) {
      fail('RELEASE_MANIFEST_DEPLOY_EXECUTION_IDENTITY_INVALID');
    }
  }
  if (value.localImageDiagnostics !== undefined) {
    const diagnostics = value.localImageDiagnostics;
    if (!diagnostics || Object.keys(diagnostics).sort().join(',') !== 'audio,runtime'
        || ['runtime', 'audio'].some((key) => !OCI_DIGEST.test(diagnostics[key]?.localEngineImageId)
          || typeof diagnostics[key]?.tag !== 'string' || diagnostics[key].tag.includes('latest'))) {
      fail('RELEASE_MANIFEST_IMAGE_DIAGNOSTICS_INVALID');
    }
  }
}

const productionFdReader = Object.freeze({ open, lstat });

export async function readTrustedReleaseBundle({
  path,
  digestPath,
  fdReader = productionFdReader,
}) {
  if (typeof path !== 'string' || typeof digestPath !== 'string'
      || path !== resolve(path) || digestPath !== resolve(digestPath)
      || basename(path) !== 'release-manifest.json' || digestPath !== `${path}.sha256`
      || dirname(path) !== dirname(digestPath)) {
    fail('RELEASE_MANIFEST_UNTRUSTED_PATH');
  }
  let ancestors;
  let parentHandle;
  let manifestBytes;
  let digestBytes;
  try {
    ancestors = await inspectAncestors(path, fdReader);
    parentHandle = await fdReader.open(dirname(path), fsConstants.O_RDONLY
      | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
    const parentBefore = await parentHandle.stat();
    validateDirectoryStat(parentBefore);
    const inspectedParent = ancestors.at(-1)?.value;
    if (inspectedParent && !sameIdentity(inspectedParent, parentBefore)) {
      fail('RELEASE_MANIFEST_CHANGED_DURING_READ');
    }
    const canAnchor = process.platform === 'linux' && Number.isInteger(parentHandle.fd);
    const anchor = canAnchor ? `/proc/self/fd/${parentHandle.fd}` : dirname(path);
    [manifestBytes, digestBytes] = await Promise.all([
      readStable(`${anchor}/release-manifest.json`, fdReader),
      readStable(`${anchor}/release-manifest.json.sha256`, fdReader),
    ]);
    const parentAfter = await parentHandle.stat();
    if (!sameStat(parentBefore, parentAfter)) fail('RELEASE_MANIFEST_CHANGED_DURING_READ');
    await assertAncestorsUnchanged(ancestors, fdReader);
  } catch (error) {
    if (error?.code?.startsWith?.('RELEASE_MANIFEST_')) throw error;
    fail('RELEASE_MANIFEST_UNTRUSTED_PATH', error);
  } finally {
    await parentHandle?.close?.();
  }
  const releaseManifestSha256 = createHash('sha256')
    .update(manifestBytes)
    .digest('hex');
  const expectedSidecar = `${releaseManifestSha256}  ${basename(path)}\n`;
  if (digestBytes.toString('ascii') !== expectedSidecar) fail('RELEASE_MANIFEST_DIGEST_MISMATCH');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    fail('RELEASE_MANIFEST_SCHEMA_INVALID', error);
  }
  if (Buffer.from(canonicalJson(manifest)).compare(manifestBytes) !== 0) {
    fail('RELEASE_MANIFEST_NOT_CANONICAL');
  }
  validateManifest(manifest);
  const manifestValue = Object.freeze({
    ...manifest,
    workerIdentity: Object.freeze({ ...manifest.workerIdentity }),
    geometry: Object.freeze({ ...manifest.geometry, rowVoices: Object.freeze([...manifest.geometry.rowVoices]) }),
    baseImages: Object.freeze({ runtime: Object.freeze({ ...manifest.baseImages.runtime }), audio: Object.freeze({ ...manifest.baseImages.audio }) }),
    imageIdentity: Object.freeze({ ...manifest.imageIdentity }),
    ...(manifest.deployExecutionIdentity ? {
      deployExecutionIdentity: Object.freeze({ ...manifest.deployExecutionIdentity }),
    } : {}),
    ...(manifest.localImageDiagnostics ? { localImageDiagnostics: Object.freeze({
      runtime: Object.freeze({ ...manifest.localImageDiagnostics.runtime }),
      audio: Object.freeze({ ...manifest.localImageDiagnostics.audio }),
    }) } : {}),
  });
  return Object.freeze({
    manifest: manifestValue,
    releaseManifestSha256,
  });
}

export async function readTrustedReleaseManifest(options) {
  const bundle = await readTrustedReleaseBundle(options);
  return bundle.manifest;
}
