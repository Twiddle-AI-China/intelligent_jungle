import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import policy from '../../release/phase6-policy.json' with { type: 'json' };
import { canonicalJson, loadReleaseEvidence,
  verifyStabilityRecord, verifyStabilityWindow } from '../tools/verify-stability-window.mjs';

const H = 'a'.repeat(64);
const revisionN = 'b'.repeat(40);
const revisionN1 = 'c'.repeat(40);
const generation = '7d196840-6373-4722-938c-3ca9fc899db7';

function release(revision, previousRevision, readyAtUnixMs) {
  return { schemaVersion: 1, releaseRevision: revision,
    previousReleaseRevision: previousRevision, runtimeOwner: 'server', audioOwner: 'world',
    phase5AcceptanceStatus: 'accepted', acceptanceSha256: H, releaseManifestSha256: H,
    runtimeImageDigest: `sha256:${'d'.repeat(64)}`, audioImageDigest: `sha256:${'e'.repeat(64)}`,
    imagesAvailable: true, readyAtUnixMs, worldGeneration: generation };
}

function samples(revision, start, hours = 24, mutate = () => {}) {
  const values = [];
  for (let at = start; at <= start + hours * 60 * 60 * 1000; at += 5 * 60 * 1000) {
    const value = { atUnixMs: at, releaseRevision: revision, runtimeOwner: 'server',
      audioOwner: 'world', abnormalCloseCount: 0, reconnectStormCount: 0,
      audioUnderrunCount: 0 };
    mutate(value, values.length); values.push(value);
  }
  return { schemaVersion: 1, samples: values };
}

function snapshot(revision, capturedAtUnixMs) {
  const envelope = { worldGeneration: generation,
    worldId: 'default', revision: 42, eventSeq: 99, protocolVersion: 1,
    snapshotSchemaVersion: 1 };
  return { schemaVersion: 1, releaseRevision: revision, releaseManifestSha256: H,
    capturedAtUnixMs, envelope,
    envelopeSha256: createHash('sha256').update(canonicalJson(envelope)).digest('hex') };
}

function valid() {
  const ready = 1_000_000;
  return { policy, previous: release(revisionN, null, 100),
    current: release(revisionN1, revisionN, ready),
    telemetry: samples(revisionN1, ready),
    snapshot: snapshot(revisionN1, ready + 24 * 60 * 60 * 1000) };
}

test('first Phase 5 release cannot remove legacy', () => {
  const value = valid();
  value.previous = { ...value.previous, runtimeOwner: 'browser', audioOwner: 'legacy',
    phase5AcceptanceStatus: 'none' };
  assert.throws(() => verifyStabilityWindow(value), /PHASE6_PREVIOUS_RELEASE_INVALID/);
});

test('N to N+1 plus 24 clean hours permits removal', () => {
  const result = verifyStabilityWindow(valid());
  assert.equal(result.allowed, true);
  assert.equal(result.successfulServerOwnerUpgrades, 1);
  assert.equal(result.sampleCount, 289);
});

test('same release or a non-contiguous previous release is rejected', () => {
  for (const previousRevision of [revisionN1, 'f'.repeat(40)]) {
    const value = valid(); value.current = { ...value.current, previousReleaseRevision: previousRevision };
    assert.throws(() => verifyStabilityWindow(value), /PHASE6_SERVER_OWNER_UPGRADE_REQUIRED/);
  }
});

test('23.99 hours and a telemetry sampling gap both fail closed', () => {
  const short = valid(); short.telemetry = samples(revisionN1, short.current.readyAtUnixMs, 23.99);
  assert.throws(() => verifyStabilityWindow(short), /PHASE6_OBSERVATION_WINDOW_TOO_SHORT/);
  const gap = valid(); gap.telemetry.samples.splice(10, 1);
  assert.throws(() => verifyStabilityWindow(gap), /PHASE6_TELEMETRY_NOT_CONTINUOUS/);
  const late = valid(); late.telemetry = samples(revisionN1,
    late.current.readyAtUnixMs + 5 * 60 * 1000 + 1);
  assert.throws(() => verifyStabilityWindow(late), /PHASE6_TELEMETRY_NOT_CONTINUOUS/);
});

test('underrun, abnormal close, reconnect storm and owner drift fail closed', () => {
  for (const field of ['audioUnderrunCount', 'abnormalCloseCount', 'reconnectStormCount']) {
    const value = valid(); value.telemetry.samples.at(-1)[field] = 1;
    assert.throws(() => verifyStabilityWindow(value), /PHASE6_STABILITY_THRESHOLD_EXCEEDED/);
  }
  const reset = valid();
  reset.telemetry.samples[10].audioUnderrunCount = 1;
  assert.throws(() => verifyStabilityWindow(reset), /PHASE6_TELEMETRY_COUNTER_RESET/);
  const owner = valid(); owner.telemetry.samples[10].runtimeOwner = 'browser';
  assert.throws(() => verifyStabilityWindow(owner), /PHASE6_TELEMETRY_INVALID/);
});

test('snapshot must bind current release, follow the window, and match its digest', () => {
  const revision = valid(); revision.snapshot.releaseRevision = revisionN;
  assert.throws(() => verifyStabilityWindow(revision), /PHASE6_SNAPSHOT_INVALID/);
  const early = valid(); early.snapshot.capturedAtUnixMs -= 1;
  assert.throws(() => verifyStabilityWindow(early), /PHASE6_SNAPSHOT_PREDATES_STABILITY_WINDOW/);
  const digest = valid(); digest.snapshot.envelope.revision += 1;
  assert.throws(() => verifyStabilityWindow(digest), /PHASE6_SNAPSHOT_INVALID/);
  const future = valid(); const futureReady = Date.now() + 1_000;
  future.current.readyAtUnixMs = futureReady;
  future.telemetry = samples(revisionN1, futureReady);
  future.snapshot = snapshot(revisionN1, futureReady + 24 * 60 * 60 * 1000);
  assert.throws(() => verifyStabilityWindow(future), /PHASE6_FUTURE_EVIDENCE_REJECTED/);
});

function writeDigestBound(path, value) {
  const body = canonicalJson(value);
  const sha256 = createHash('sha256').update(body).digest('hex');
  writeFileSync(path, body);
  writeFileSync(`${path}.sha256`, `${sha256}  ${path.split('/').at(-1)}\n`);
  return sha256;
}

function releaseDirectory(revision = revisionN1, previousRevision = revisionN) {
  const directory = mkdtempSync(join(tmpdir(), 'phase6-release-'));
  const manifest = { schemaVersion: 1,
    workerIdentity: { releaseRevision: revision },
    imageIdentity: { runtime: `sha256:${'d'.repeat(64)}`,
      audio: `sha256:${'e'.repeat(64)}` } };
  const manifestSha256 = writeDigestBound(join(directory, 'release-manifest.json'), manifest);
  const acceptance = { schemaVersion: 1, status: 'accepted',
    release: { releaseManifestSha256: manifestSha256, releaseRevision: revision } };
  const acceptanceBody = canonicalJson(acceptance);
  writeFileSync(join(directory, 'acceptance.json'), acceptanceBody);
  const acceptanceSha256 = createHash('sha256').update(acceptanceBody).digest('hex');
  writeFileSync(join(directory, 'package.json'), canonicalJson({ schemaVersion: 1,
    status: 'packaged', releaseManifestSha256: manifestSha256, acceptanceSha256,
    equivalenceSha256: H, acceptanceValidatorSha256: H }));
  writeDigestBound(join(directory, 'cutover-record.json'), { schemaVersion: 1,
    outcome: 'succeeded', releaseManifestSha256: manifestSha256,
    releaseRevision: revision, previousReleaseRevision: previousRevision,
    runtimeOwner: 'server', audioOwner: 'world', readyAtUnixMs: 1_000_000,
    worldGeneration: generation });
  mkdirSync(join(directory, 'images'));
  writeFileSync(join(directory, 'images/runtime.oci.tar'), 'runtime');
  writeFileSync(join(directory, 'images/audio.oci.tar'), 'audio');
  return { directory, manifestPath: join(directory, 'release-manifest.json') };
}

test('release evidence loader binds manifest, acceptance, package, cutover, and images', () => {
  const fixture = releaseDirectory();
  try {
    const result = loadReleaseEvidence(fixture.manifestPath,
      { acceptanceValidator() {}, imageValidator() {} });
    assert.equal(result.releaseRevision, revisionN1);
    assert.equal(result.previousReleaseRevision, revisionN);
    assert.equal(result.imagesAvailable, true);
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('release evidence loader verifies OCI contents rather than file existence', () => {
  const fixture = releaseDirectory();
  try {
    assert.throws(() => loadReleaseEvidence(fixture.manifestPath,
      { acceptanceValidator() {} }), /PHASE6_RELEASE_IMAGE_INVALID/);
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('release evidence loader fails closed on tampering or a missing image', () => {
  for (const mutate of [
    ({ directory }) => writeFileSync(join(directory, 'acceptance.json'), '{}'),
    ({ directory }) => writeFileSync(join(directory, 'package.json'), '{}'),
    ({ directory }) => writeFileSync(join(directory, 'cutover-record.json'), '{}'),
    ({ directory }) => writeFileSync(join(directory, 'release-manifest.json.sha256'), 'bad\n'),
    ({ directory }) => rmSync(join(directory, 'images/audio.oci.tar')),
  ]) {
    const fixture = releaseDirectory();
    try {
      mutate(fixture);
      assert.throws(() => {
        const result = loadReleaseEvidence(fixture.manifestPath,
          { acceptanceValidator() {}, imageValidator() {} });
        if (!result.imagesAvailable) verifyStabilityWindow({ ...valid(), current: result });
      }, /PHASE6_/);
    } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
  }
});

test('aggregate stability record must be digest-bound and exactly reproducible from raw evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phase6-record-'));
  const path = join(directory, 'phase6-stability-record.json');
  const inputs = valid();
  try {
    writeDigestBound(path, verifyStabilityWindow(inputs));
    assert.equal(verifyStabilityRecord({ recordPath: path, ...inputs }).allowed, true);
    inputs.telemetry.samples.at(-1).audioUnderrunCount = 1;
    assert.throws(() => verifyStabilityRecord({ recordPath: path, ...inputs }),
      /PHASE6_STABILITY_THRESHOLD_EXCEEDED/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
