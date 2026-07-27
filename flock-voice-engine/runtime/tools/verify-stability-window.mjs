#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const OCI = /^sha256:[0-9a-f]{64}$/;
const MAX_SAMPLE_GAP_MS = 5 * 60 * 1000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(code);
}

function validatePolicy(policy) {
  const keys = ['schemaVersion', 'minimumObservationHours',
    'minimumSuccessfulServerOwnerUpgrades', 'requirePreviousRelease',
    'requireCurrentWorldSnapshot', 'maximumAbnormalCloseCount',
    'maximumReconnectStormCount', 'maximumAudioUnderrunCount'];
  exactObject(policy, keys, 'PHASE6_POLICY_INVALID');
  if (policy.schemaVersion !== 1 || policy.minimumObservationHours !== 24
      || policy.minimumSuccessfulServerOwnerUpgrades !== 1
      || policy.requirePreviousRelease !== true || policy.requireCurrentWorldSnapshot !== true
      || policy.maximumAbnormalCloseCount !== 0 || policy.maximumReconnectStormCount !== 0
      || policy.maximumAudioUnderrunCount !== 0) fail('PHASE6_POLICY_INVALID');
}

function validateRelease(value, label) {
  const keys = ['schemaVersion', 'releaseRevision', 'previousReleaseRevision',
    'runtimeOwner', 'audioOwner', 'phase5AcceptanceStatus', 'acceptanceSha256',
    'releaseManifestSha256', 'runtimeImageDigest', 'audioImageDigest',
    'imagesAvailable', 'readyAtUnixMs', 'worldGeneration'];
  exactObject(value, keys, `PHASE6_${label}_RELEASE_INVALID`);
  if (value.schemaVersion !== 1 || !HEX40.test(value.releaseRevision)
      || (value.previousReleaseRevision !== null && !HEX40.test(value.previousReleaseRevision))
      || value.runtimeOwner !== 'server' || value.audioOwner !== 'world'
      || value.phase5AcceptanceStatus !== 'accepted' || !HEX64.test(value.acceptanceSha256)
      || !HEX64.test(value.releaseManifestSha256) || !OCI.test(value.runtimeImageDigest)
      || !OCI.test(value.audioImageDigest) || value.imagesAvailable !== true
      || !Number.isSafeInteger(value.readyAtUnixMs) || value.readyAtUnixMs < 0
      || typeof value.worldGeneration !== 'string' || !value.worldGeneration) {
    fail(`PHASE6_${label}_RELEASE_INVALID`);
  }
}

function validateTelemetry(telemetry, current, policy, nowUnixMs) {
  exactObject(telemetry, ['schemaVersion', 'samples'], 'PHASE6_TELEMETRY_INVALID');
  if (telemetry.schemaVersion !== 1 || !Array.isArray(telemetry.samples)
      || telemetry.samples.length < 2) fail('PHASE6_TELEMETRY_INVALID');
  const keys = ['atUnixMs', 'releaseRevision', 'runtimeOwner', 'audioOwner',
    'abnormalCloseCount', 'reconnectStormCount', 'audioUnderrunCount'];
  let previousAt = null;
  let previousCounts = null;
  for (const sample of telemetry.samples) {
    exactObject(sample, keys, 'PHASE6_TELEMETRY_INVALID');
    if (!Number.isSafeInteger(sample.atUnixMs) || sample.atUnixMs < current.readyAtUnixMs
        || sample.releaseRevision !== current.releaseRevision
        || sample.runtimeOwner !== 'server' || sample.audioOwner !== 'world'
        || !Number.isSafeInteger(sample.abnormalCloseCount) || sample.abnormalCloseCount < 0
        || !Number.isSafeInteger(sample.reconnectStormCount) || sample.reconnectStormCount < 0
        || !Number.isSafeInteger(sample.audioUnderrunCount) || sample.audioUnderrunCount < 0) {
      fail('PHASE6_TELEMETRY_INVALID');
    }
    if (previousAt !== null && (sample.atUnixMs <= previousAt
        || sample.atUnixMs - previousAt > MAX_SAMPLE_GAP_MS)) fail('PHASE6_TELEMETRY_NOT_CONTINUOUS');
    const counts = [sample.abnormalCloseCount, sample.reconnectStormCount,
      sample.audioUnderrunCount];
    if (previousCounts && counts.some((count, index) => count < previousCounts[index])) {
      fail('PHASE6_TELEMETRY_COUNTER_RESET');
    }
    previousAt = sample.atUnixMs;
    previousCounts = counts;
  }
  const first = telemetry.samples[0];
  const last = telemetry.samples.at(-1);
  if (first.atUnixMs - current.readyAtUnixMs > MAX_SAMPLE_GAP_MS) {
    fail('PHASE6_TELEMETRY_NOT_CONTINUOUS');
  }
  if (current.readyAtUnixMs > nowUnixMs || last.atUnixMs > nowUnixMs) {
    fail('PHASE6_FUTURE_EVIDENCE_REJECTED');
  }
  if (last.atUnixMs - first.atUnixMs < policy.minimumObservationHours * 60 * 60 * 1000) {
    fail('PHASE6_OBSERVATION_WINDOW_TOO_SHORT');
  }
  if (last.abnormalCloseCount > policy.maximumAbnormalCloseCount
      || last.reconnectStormCount > policy.maximumReconnectStormCount
      || last.audioUnderrunCount > policy.maximumAudioUnderrunCount) {
    fail('PHASE6_STABILITY_THRESHOLD_EXCEEDED');
  }
  return { startedAtUnixMs: first.atUnixMs, endedAtUnixMs: last.atUnixMs,
    sampleCount: telemetry.samples.length,
    telemetrySha256: createHash('sha256').update(canonicalJson(telemetry)).digest('hex') };
}

function validateSnapshot(snapshot, current, nowUnixMs) {
  exactObject(snapshot, ['schemaVersion', 'releaseRevision', 'releaseManifestSha256', 'capturedAtUnixMs',
    'envelope', 'envelopeSha256'], 'PHASE6_SNAPSHOT_INVALID');
  const digest = createHash('sha256').update(canonicalJson(snapshot.envelope)).digest('hex');
  if (snapshot.schemaVersion !== 1 || snapshot.releaseRevision !== current.releaseRevision
      || snapshot.releaseManifestSha256 !== current.releaseManifestSha256
      || !Number.isSafeInteger(snapshot.capturedAtUnixMs)
      || snapshot.capturedAtUnixMs < current.readyAtUnixMs || digest !== snapshot.envelopeSha256
      || !snapshot.envelope || typeof snapshot.envelope !== 'object'
      || Array.isArray(snapshot.envelope)
      || typeof snapshot.envelope.worldId !== 'string' || !snapshot.envelope.worldId
      || typeof snapshot.envelope.worldGeneration !== 'string'
      || snapshot.envelope.worldGeneration !== current.worldGeneration
      || !Number.isSafeInteger(snapshot.envelope.revision) || snapshot.envelope.revision < 0
      || !Number.isSafeInteger(snapshot.envelope.eventSeq) || snapshot.envelope.eventSeq < 0
      || snapshot.envelope.protocolVersion !== 1 || snapshot.envelope.snapshotSchemaVersion !== 1
      || snapshot.capturedAtUnixMs > nowUnixMs) fail('PHASE6_SNAPSHOT_INVALID');
  return { snapshotSha256: digest, worldGeneration: snapshot.envelope.worldGeneration,
    capturedAtUnixMs: snapshot.capturedAtUnixMs };
}

export function verifyStabilityWindow({ policy, current, previous, telemetry, snapshot,
  nowUnixMs = Date.now() }) {
  if (!Number.isSafeInteger(nowUnixMs) || nowUnixMs < 0) fail('PHASE6_CLOCK_INVALID');
  validatePolicy(policy);
  validateRelease(current, 'CURRENT');
  if (!previous) fail('PHASE6_PREVIOUS_RELEASE_REQUIRED');
  validateRelease(previous, 'PREVIOUS');
  if (current.releaseRevision === previous.releaseRevision
      || current.previousReleaseRevision !== previous.releaseRevision) {
    fail('PHASE6_SERVER_OWNER_UPGRADE_REQUIRED');
  }
  if (current.readyAtUnixMs <= previous.readyAtUnixMs) fail('PHASE6_RELEASE_ORDER_INVALID');
  const window = validateTelemetry(telemetry, current, policy, nowUnixMs);
  const snapshotEvidence = validateSnapshot(snapshot, current, nowUnixMs);
  if (snapshotEvidence.capturedAtUnixMs < window.endedAtUnixMs) {
    fail('PHASE6_SNAPSHOT_PREDATES_STABILITY_WINDOW');
  }
  return Object.freeze({ schemaVersion: 1, status: 'allowed', allowed: true,
    currentReleaseRevision: current.releaseRevision,
    previousReleaseRevision: previous.releaseRevision,
    currentReleaseManifestSha256: current.releaseManifestSha256,
    previousReleaseManifestSha256: previous.releaseManifestSha256,
    currentAcceptanceSha256: current.acceptanceSha256,
    previousAcceptanceSha256: previous.acceptanceSha256,
    currentRuntimeImageDigest: current.runtimeImageDigest,
    currentAudioImageDigest: current.audioImageDigest,
    previousRuntimeImageDigest: previous.runtimeImageDigest,
    previousAudioImageDigest: previous.audioImageDigest,
    successfulServerOwnerUpgrades: 1, ...window, ...snapshotEvidence });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || argv[index + 1] === undefined) fail('PHASE6_ARGUMENTS_INVALID');
    result[key.slice(2)] = argv[index + 1];
  }
  return result;
}

function readJson(path, code) {
  try { return JSON.parse(readFileSync(resolve(path), 'utf8')); } catch { fail(code); }
}

function readDigestBoundJson(path, code, expectedBasename = basename(path)) {
  const absolute = resolve(path);
  let bytes; let sidecar;
  try {
    bytes = readFileSync(absolute);
    sidecar = readFileSync(`${absolute}.sha256`, 'ascii');
  } catch { fail(code); }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sidecar !== `${sha256}  ${expectedBasename}\n`) fail(code);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(code); }
  if (bytes.toString('utf8') !== canonicalJson(value)) fail(code);
  return { value, sha256 };
}

function digestFile(path, code) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { fail(code); }
}

function validateOciArchive(path, expectedDigest) {
  const member = (name) => {
    try { return execFileSync('tar', ['-xOf', path, name],
      { maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { fail('PHASE6_OCI_IMAGE_INVALID'); }
  };
  let index;
  try { index = JSON.parse(member('index.json')); } catch { fail('PHASE6_OCI_IMAGE_INVALID'); }
  const selected = index?.manifests?.filter((item) => item?.platform?.architecture === 'arm64'
    && item?.platform?.os === 'linux');
  if (selected?.length !== 1 || selected[0].digest !== expectedDigest) {
    fail('PHASE6_OCI_IMAGE_DIGEST_MISMATCH');
  }
  const descriptor = selected[0];
  const manifestBytes = member(`blobs/sha256/${expectedDigest.slice(7)}`);
  if (manifestBytes.length !== descriptor.size
      || `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}` !== expectedDigest) {
    fail('PHASE6_OCI_IMAGE_DIGEST_MISMATCH');
  }
  let manifest;
  try { manifest = JSON.parse(manifestBytes); } catch { fail('PHASE6_OCI_IMAGE_INVALID'); }
  for (const child of [manifest.config, ...(manifest.layers ?? [])]) {
    if (!OCI.test(child?.digest) || !Number.isSafeInteger(child?.size) || child.size < 0) {
      fail('PHASE6_OCI_IMAGE_INVALID');
    }
    const bytes = member(`blobs/sha256/${child.digest.slice(7)}`);
    if (bytes.length !== child.size
        || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== child.digest) {
      fail('PHASE6_OCI_IMAGE_DIGEST_MISMATCH');
    }
  }
}

function validateAcceptanceBundle({ directory, manifestPath, manifest, packageRecord }) {
  const validatorPath = resolve(directory, 'deploy/validate_phase5_acceptance.py');
  const equivalencePath = resolve(directory, 'acceptance-inputs/staging-equivalence.json');
  const validatorSha256 = digestFile(validatorPath, 'PHASE6_RELEASE_ACCEPTANCE_INVALID');
  for (const name of ['validate_phase5_acceptance.py', 'acceptance.schema.json',
    'machine-attestation.schema.json']) {
    const actual = digestFile(resolve(directory, `deploy/${name}`),
      'PHASE6_RELEASE_ACCEPTANCE_INVALID');
    if (manifest.deployExecutionIdentity?.[name] !== actual) {
      fail('PHASE6_RELEASE_ACCEPTANCE_INVALID');
    }
  }
  if (packageRecord.equivalenceSha256 !== digestFile(equivalencePath,
    'PHASE6_RELEASE_ACCEPTANCE_INVALID')
      || packageRecord.acceptanceValidatorSha256 !== validatorSha256
      || manifest.deployExecutionIdentity?.['validate_phase5_acceptance.py'] !== validatorSha256) {
    fail('PHASE6_RELEASE_ACCEPTANCE_INVALID');
  }
  const result = spawnSync(process.env.PYTHON ?? 'python3', [validatorPath,
    '--acceptance', resolve(directory, 'acceptance.json'), '--release', manifestPath,
    '--equivalence', equivalencePath], { cwd: directory, encoding: 'utf8' });
  if (result.status !== 0 || result.stdout.trim() !== 'PHASE5_ACCEPTANCE_VALID') {
    fail('PHASE6_RELEASE_ACCEPTANCE_INVALID');
  }
}

export function loadReleaseEvidence(manifestPath, {
  acceptanceValidator = validateAcceptanceBundle, imageValidator = validateOciArchive,
} = {}) {
  const absolute = resolve(manifestPath);
  if (basename(absolute) !== 'release-manifest.json') fail('PHASE6_RELEASE_PATH_INVALID');
  const directory = dirname(absolute);
  const manifest = readDigestBoundJson(absolute, 'PHASE6_RELEASE_MANIFEST_INVALID');
  const acceptancePath = resolve(directory, 'acceptance.json');
  const packagePath = resolve(directory, 'package.json');
  const cutoverPath = resolve(directory, 'cutover-record.json');
  const acceptance = readJson(acceptancePath, 'PHASE6_RELEASE_ACCEPTANCE_INVALID');
  const packageRecord = readJson(packagePath, 'PHASE6_RELEASE_PACKAGE_INVALID');
  const cutover = readDigestBoundJson(cutoverPath, 'PHASE6_CUTOVER_RECORD_INVALID');
  const acceptanceSha256 = digestFile(acceptancePath, 'PHASE6_RELEASE_ACCEPTANCE_INVALID');
  const revision = manifest.value?.workerIdentity?.releaseRevision;
  const runtimeImageDigest = manifest.value?.imageIdentity?.runtime;
  const audioImageDigest = manifest.value?.imageIdentity?.audio;
  if (manifest.value?.schemaVersion !== 1 || !HEX40.test(revision)
      || !OCI.test(runtimeImageDigest) || !OCI.test(audioImageDigest)
      || acceptance?.schemaVersion !== 1 || acceptance.status !== 'accepted'
      || acceptance.release?.releaseManifestSha256 !== manifest.sha256
      || acceptance.release?.releaseRevision !== revision
      || packageRecord?.schemaVersion !== 1 || packageRecord.status !== 'packaged'
      || packageRecord.releaseManifestSha256 !== manifest.sha256
      || packageRecord.acceptanceSha256 !== acceptanceSha256
      || !HEX64.test(packageRecord.equivalenceSha256)
      || !HEX64.test(packageRecord.acceptanceValidatorSha256)
      || cutover.value?.schemaVersion !== 1 || cutover.value.outcome !== 'succeeded'
      || cutover.value.releaseManifestSha256 !== manifest.sha256
      || cutover.value.releaseRevision !== revision
      || cutover.value.runtimeOwner !== 'server' || cutover.value.audioOwner !== 'world'
      || typeof cutover.value.worldGeneration !== 'string' || !cutover.value.worldGeneration
      || !Number.isSafeInteger(cutover.value.readyAtUnixMs)
      || (cutover.value.previousReleaseRevision !== null
        && !HEX40.test(cutover.value.previousReleaseRevision))) {
    fail('PHASE6_RELEASE_EVIDENCE_MISMATCH');
  }
  acceptanceValidator({ directory, manifestPath: absolute, manifest: manifest.value,
    packageRecord });
  let imagesAvailable;
  try {
    const runtimeImage = resolve(directory, 'images/runtime.oci.tar');
    const audioImage = resolve(directory, 'images/audio.oci.tar');
    imagesAvailable = statSync(runtimeImage).isFile() && statSync(audioImage).isFile();
    if (imagesAvailable) {
      imageValidator(runtimeImage, runtimeImageDigest);
      imageValidator(audioImage, audioImageDigest);
    }
  } catch { fail('PHASE6_RELEASE_IMAGE_INVALID'); }
  if (!imagesAvailable) fail('PHASE6_RELEASE_IMAGE_INVALID');
  return { schemaVersion: 1, releaseRevision: revision,
    previousReleaseRevision: cutover.value.previousReleaseRevision,
    runtimeOwner: cutover.value.runtimeOwner, audioOwner: cutover.value.audioOwner,
    phase5AcceptanceStatus: acceptance.status, acceptanceSha256,
    releaseManifestSha256: manifest.sha256, runtimeImageDigest, audioImageDigest,
    imagesAvailable, readyAtUnixMs: cutover.value.readyAtUnixMs,
    worldGeneration: cutover.value.worldGeneration };
}

export function verifyStabilityRecord({ recordPath, policy, current, previous, telemetry, snapshot,
  nowUnixMs = Date.now() }) {
  const bound = readDigestBoundJson(recordPath, 'PHASE6_STABILITY_RECORD_INVALID');
  const expected = verifyStabilityWindow({ policy, current, previous, telemetry, snapshot, nowUnixMs });
  if (canonicalJson(bound.value) !== canonicalJson(expected)) fail('PHASE6_STABILITY_RECORD_MISMATCH');
  return expected;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const verifying = Boolean(args.record);
  for (const key of ['policy', 'current-manifest', 'previous-manifest', 'telemetry', 'snapshot']) {
    if (!args[key]) fail('PHASE6_ARGUMENTS_INVALID');
  }
  if (verifying === Boolean(args.output)) fail('PHASE6_ARGUMENTS_INVALID');
  const inputs = { policy: readJson(args.policy, 'PHASE6_POLICY_INVALID'),
    current: loadReleaseEvidence(args['current-manifest']),
    previous: loadReleaseEvidence(args['previous-manifest']),
    telemetry: readJson(args.telemetry, 'PHASE6_TELEMETRY_INVALID'),
    snapshot: readJson(args.snapshot, 'PHASE6_SNAPSHOT_INVALID') };
  if (verifying) verifyStabilityRecord({ recordPath: args.record, ...inputs });
  else {
    const record = verifyStabilityWindow(inputs);
    writeFileSync(resolve(args.output), canonicalJson(record), { flag: 'wx' });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
