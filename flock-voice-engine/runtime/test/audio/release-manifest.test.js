import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  readTrustedReleaseBundle,
  readTrustedReleaseManifest,
} from '../../src/audio/release-manifest.js';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function fixture() {
  const geometry = { sampleRate: 44100, blockFrames: 4096, poolSize: 5,
    rowVoices: ['bass', 'pad', 'lead', 'pluck', 'pad'] };
  return {
    schemaVersion: 1,
    workerIdentity: {
      releaseRevision: '1'.repeat(40), sourceManifestSha256: '2'.repeat(64),
      protocolFamily: 'flock-audio-ipc', protocolVersion: 1,
      audioArtifactKind: 'release-artifact', audioArtifactSha256: '3'.repeat(64),
    },
    geometry,
    manifestGeometrySha256: createHash('sha256').update(canonical(geometry)).digest('hex'),
    baseImages: {
      runtime: { repository: 'example/runtime', digest: `sha256:${'4'.repeat(64)}` },
      audio: { repository: 'example/audio', digest: `sha256:${'5'.repeat(64)}` },
    },
    imageIdentity: { runtime: `sha256:${'6'.repeat(64)}`, audio: `sha256:${'7'.repeat(64)}` },
  };
}

async function writeFixture(value = fixture()) {
  const root = await mkdtemp(join(tmpdir(), 'flock-release-'));
  const trustedRoot = await realpath(root);
  const path = join(trustedRoot, 'release-manifest.json');
  const digestPath = `${path}.sha256`;
  const body = Buffer.from(canonical(value));
  const digest = createHash('sha256').update(body).digest('hex');
  await writeFile(path, body, { mode: 0o600 });
  await writeFile(digestPath, `${digest}  release-manifest.json\n`, { mode: 0o600 });
  return { root: trustedRoot, path, digestPath };
}

function trustedPosixStat(value) {
  const mode = (value.mode & ~0o777) | (value.isDirectory() ? 0o700 : 0o600);
  return new Proxy(value, {
    get(target, property) {
      if (property === 'mode') return mode;
      const member = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

function trustedPosixFdReader() {
  return {
    async open(...args) {
      const handle = await open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'stat') {
            return async (...statArgs) => trustedPosixStat(await target.stat(...statArgs));
          }
          const member = Reflect.get(target, property, target);
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
    },
    async lstat(...args) {
      return trustedPosixStat(await lstat(...args));
    },
  };
}

function readTrustedFixture(paths) {
  return readTrustedReleaseManifest({ ...paths, fdReader: trustedPosixFdReader() });
}

function syntheticPaths(label) {
  const root = resolve(tmpdir(), 'flock-release-security', label);
  const path = join(root, 'release-manifest.json');
  return { root, path, digestPath: `${path}.sha256` };
}

function syntheticStat({ kind, mode, ino, size = 0 }) {
  return Object.freeze({
    dev: 1,
    ino,
    uid: 0,
    mode,
    size,
    mtimeMs: 1,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink',
  });
}

function syntheticFdReader({
  paths,
  trace,
  ancestorStats = new Map(),
  manifestStat,
  manifestOpenError = null,
}) {
  const manifestBytes = Buffer.from(canonical(fixture()));
  const digest = createHash('sha256').update(manifestBytes).digest('hex');
  const trustedDirectory = syntheticStat({ kind: 'directory', mode: 0o700, ino: 1 });
  const trustedManifest = manifestStat ?? syntheticStat({
    kind: 'file', mode: 0o600, ino: 2, size: manifestBytes.length,
  });
  const digestBytes = Buffer.from(`${digest}  release-manifest.json\n`);
  const trustedDigest = syntheticStat({
    kind: 'file', mode: 0o600, ino: 3, size: digestBytes.length,
  });
  const statKind = (value) => (
    value.isSymbolicLink() ? 'symlink' : value.isDirectory() ? 'directory' : 'file'
  );
  const handle = (target, stat, bytes = Buffer.alloc(0)) => ({
    async stat() {
      trace.push({ operation: 'stat', target, kind: statKind(stat), mode: stat.mode });
      return stat;
    },
    async readFile() {
      trace.push({ operation: 'readFile', target });
      return Buffer.from(bytes);
    },
    async close() {
      trace.push({ operation: 'close', target });
    },
  });
  return {
    async lstat(path) {
      const stat = ancestorStats.get(path) ?? trustedDirectory;
      trace.push({
        operation: 'lstat', path, kind: statKind(stat), mode: stat.mode,
      });
      return stat;
    },
    async open(path, flags) {
      const absolutePath = resolve(path);
      trace.push({ operation: 'open', path: absolutePath, flags });
      if (absolutePath === dirname(paths.path)) {
        return handle('parent', trustedDirectory);
      }
      if (absolutePath === paths.path) {
        if (manifestOpenError) throw manifestOpenError;
        return handle('manifest', trustedManifest, manifestBytes);
      }
      if (absolutePath === paths.digestPath) {
        return handle('digest', trustedDigest, digestBytes);
      }
      const error = new Error(`unexpected synthetic path: ${path}`);
      error.code = 'ENOENT';
      throw error;
    },
  };
}

test('expected worker identity comes from one trusted manifest read', async () => {
  const paths = await writeFixture();
  const trusted = await readTrustedFixture(paths);
  assert.deepEqual(trusted.workerIdentity, fixture().workerIdentity);
  assert.ok(Object.isFrozen(trusted.workerIdentity));
});

test('trusted bundle owns the verified manifest digest from the same read',
    async () => {
      const paths = await writeFixture();
      const expectedBytes = Buffer.from(canonical(fixture()));
      const bundle = await readTrustedReleaseBundle({
        ...paths,
        fdReader: trustedPosixFdReader(),
      });

      assert.deepEqual(Object.keys(bundle).sort(), [
        'manifest',
        'releaseManifestSha256',
      ]);
      assert.equal(
        bundle.releaseManifestSha256,
        createHash('sha256').update(expectedBytes).digest('hex'),
      );
      assert.deepEqual(bundle.manifest.workerIdentity, fixture().workerIdentity);
      assert.equal(Object.isFrozen(bundle), true);
      assert.equal(Object.isFrozen(bundle.manifest), true);
    });

test('unrelated ancestor directory churn does not impersonate the trusted path', async () => {
  const paths = await writeFixture();
  const ancestor = await realpath(tmpdir());
  let churn = null;
  const trustedReader = trustedPosixFdReader();
  const fdReader = {
    open: trustedReader.open,
    async lstat(path) {
      const value = await trustedReader.lstat(path);
      if (path === ancestor && churn === null) churn = await mkdtemp(join(ancestor, 'flock-ancestor-churn-'));
      return value;
    },
  };
  try {
    const trusted = await readTrustedReleaseManifest({ ...paths, fdReader });
    assert.deepEqual(trusted.workerIdentity, fixture().workerIdentity);
  } finally {
    if (churn) await rm(churn, { recursive: true, force: true });
  }
});

test('symlink and group-writable manifest paths fail closed', async () => {
  const symlinkPaths = syntheticPaths('manifest-symlink');
  const symlinkTrace = [];
  const symlinkError = new Error('synthetic symlink rejected by open');
  symlinkError.code = 'ELOOP';
  const symlinkReader = syntheticFdReader({
    paths: symlinkPaths,
    trace: symlinkTrace,
    manifestOpenError: symlinkError,
  });
  await assert.rejects(readTrustedReleaseManifest({
    ...symlinkPaths,
    fdReader: symlinkReader,
  }), (error) => (
    error.code === 'RELEASE_MANIFEST_UNTRUSTED_PATH' && error.cause?.code === 'ELOOP'
  ));
  const symlinkOpen = symlinkTrace.find((entry) => (
    entry.operation === 'open' && entry.path === symlinkPaths.path
  ));
  assert.ok(symlinkOpen);
  assert.equal(symlinkOpen.flags,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  assert.equal(symlinkTrace.some((entry) => (
    entry.operation === 'stat' && entry.target === 'manifest'
  )), false);

  const groupPaths = syntheticPaths('group-writable-manifest');
  const groupTrace = [];
  const groupReader = syntheticFdReader({
    paths: groupPaths,
    trace: groupTrace,
    manifestStat: syntheticStat({ kind: 'file', mode: 0o620, ino: 2 }),
  });
  await assert.rejects(readTrustedReleaseManifest({ ...groupPaths, fdReader: groupReader }),
    /RELEASE_MANIFEST_UNTRUSTED_PATH/);
  const ancestorVisits = groupTrace.filter((entry) => entry.operation === 'lstat');
  assert.equal(ancestorVisits.at(-1).path, groupPaths.root);
  assert.equal(groupTrace.some((entry) => (
    entry.operation === 'stat' && entry.target === 'parent' && (entry.mode & 0o022) === 0
  )), true);
  assert.equal(groupTrace.some((entry) => (
    entry.operation === 'stat' && entry.target === 'manifest'
      && (entry.mode & 0o022) === 0o020
  )), true);
  assert.equal(groupTrace.some((entry) => (
    entry.operation === 'readFile' && entry.target === 'manifest'
  )), false);
});

test('a symlinked ancestor cannot redirect the trusted identity pair', async () => {
  const groupPaths = syntheticPaths('group-writable-ancestor');
  const groupTrace = [];
  const groupReader = syntheticFdReader({
    paths: groupPaths,
    trace: groupTrace,
    ancestorStats: new Map([[
      groupPaths.root,
      syntheticStat({ kind: 'directory', mode: 0o720, ino: 4 }),
    ]]),
  });
  await assert.rejects(readTrustedReleaseManifest({
    ...groupPaths,
    fdReader: groupReader,
  }), /RELEASE_MANIFEST_UNTRUSTED_PATH/);
  assert.deepEqual(groupTrace.at(-1), {
    operation: 'lstat',
    path: groupPaths.root,
    kind: 'directory',
    mode: 0o720,
  });
  assert.equal(groupTrace.some((entry) => entry.operation === 'open'), false);

  const symlinkPaths = syntheticPaths('symlink-ancestor');
  const symlinkTrace = [];
  const symlinkReader = syntheticFdReader({
    paths: symlinkPaths,
    trace: symlinkTrace,
    ancestorStats: new Map([[
      symlinkPaths.root,
      syntheticStat({ kind: 'symlink', mode: 0o700, ino: 5 }),
    ]]),
  });
  await assert.rejects(readTrustedReleaseManifest({
    ...symlinkPaths,
    fdReader: symlinkReader,
  }), /RELEASE_MANIFEST_UNTRUSTED_PATH/);
  assert.deepEqual(symlinkTrace.at(-1), {
    operation: 'lstat',
    path: symlinkPaths.root,
    kind: 'symlink',
    mode: 0o700,
  });
  assert.equal(symlinkTrace.some((entry) => entry.operation === 'open'), false);
});

test('non-canonical dot segments cannot change kernel path resolution', async () => {
  const paths = await writeFixture();
  await assert.rejects(readTrustedReleaseManifest({
    path: `${paths.root}/child/../release-manifest.json`,
    digestPath: `${paths.root}/child/../release-manifest.json.sha256`,
  }), /RELEASE_MANIFEST_UNTRUSTED_PATH/);
});

test('digest, schema, geometry and image identity failures are distinct', async () => {
  const badDigest = await writeFixture();
  await writeFile(badDigest.digestPath, `${'0'.repeat(64)}  release-manifest.json\n`, { mode: 0o600 });
  await assert.rejects(readTrustedFixture(badDigest), /RELEASE_MANIFEST_DIGEST_MISMATCH/);

  const schema = fixture();
  schema.unexpected = true;
  await assert.rejects(readTrustedFixture(await writeFixture(schema)), /RELEASE_MANIFEST_SCHEMA_INVALID/);

  const geometry = fixture();
  geometry.geometry.sampleRate = 0;
  geometry.manifestGeometrySha256 = createHash('sha256').update(canonical(geometry.geometry)).digest('hex');
  await assert.rejects(readTrustedFixture(await writeFixture(geometry)), /RELEASE_MANIFEST_GEOMETRY_INVALID/);

  const image = fixture();
  image.imageIdentity.audio = 'latest';
  await assert.rejects(readTrustedFixture(await writeFixture(image)), /RELEASE_MANIFEST_IMAGE_IDENTITY_INVALID/);
});

test('non-canonical manifest bytes are rejected even with a matching sidecar', async () => {
  const paths = await writeFixture();
  const body = Buffer.from(JSON.stringify(fixture(), null, 2));
  await writeFile(paths.path, body, { mode: 0o600 });
  const digest = createHash('sha256').update(body).digest('hex');
  await writeFile(paths.digestPath, `${digest}  release-manifest.json\n`, { mode: 0o600 });
  await assert.rejects(readTrustedFixture(paths), /RELEASE_MANIFEST_NOT_CANONICAL/);
});

test('generic trusted manifest accepts only an optional lowercase production graph digest', async () => {
  const valid = fixture();
  valid.productionGraphSha256 = '8'.repeat(64);
  const trusted = await readTrustedFixture(await writeFixture(valid));
  assert.equal(trusted.productionGraphSha256, valid.productionGraphSha256);

  for (const digest of ['8'.repeat(63), 'G'.repeat(64), 'SHA256:' + '8'.repeat(64)]) {
    const invalid = fixture();
    invalid.productionGraphSha256 = digest;
    await assert.rejects(readTrustedFixture(await writeFixture(invalid)),
      /RELEASE_MANIFEST_PRODUCTION_GRAPH_IDENTITY_INVALID/);
  }
});

test('deploy execution identity requires the exact fixed controller closure', async () => {
  const names = [
    'acceptance.schema.json',
    'legacy-lease.mjs',
    'machine-attestation.schema.json',
    'phase5-fault-verifier/lib/phase5-fault-evidence.mjs',
    'phase5-fault-verifier/lib/phase5-fault-semantics.mjs',
    'phase5-fault-verifier/lib/phase5-fault-transport-projection.mjs',
    'phase5-fault-verifier/lib/phase5-fault-validation.mjs',
    'phase5-fault-verifier/verify-phase5-capture-proof.mjs',
    'phase5-fault-verifier/verify-phase5-fault-evidence.mjs',
    'phase5-browser-preflight/flock-voice-engine/runtime/package.json',
    'phase5-browser-preflight/flock-voice-engine/runtime/package-lock.json',
    'phase5-browser-preflight/flock-voice-engine/runtime/playwright.phase5-acceptance.config.js',
    'phase5-browser-preflight/flock-voice-engine/runtime/test/e2e/phase5-local.spec.js',
    'phase5-browser-preflight/flock-voice-engine/runtime/tools/production-graph-config.mjs',
    'phase5-browser-preflight/flock-voice-engine/runtime/tools/lib/production-graph.mjs',
    'phase5-browser-preflight/flock-voice-engine/runtime/tools/lib/static-route-manifest.mjs',
    'phase5-browser-preflight/flock-voice-engine/runtime/tools/lib/candidate-browser-transport.mjs',
    'phase5-browser-preflight/flock-voice-engine/runtime/tools/lib/candidate-ops.mjs',
    'phase5-browser-preflight/flock-voice-engine/runtime/tools/lib/phase5-lease-evidence.mjs',
    'phase5-browser-preflight/flock-voice-engine/runtime/src/security/static-manifest-contract.js',
    'phase5-summary/capture_machine_attestation.py',
    'phase5-summary/phase5_capture_channel_client.py',
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
    'phase5-summary/lib/phase5-websocket-client.mjs',
    'phase5_candidate_attempt.py',
    'phase5_candidate_bootstrap.py',
    'prepare-cutover-request.mjs',
    'release.sh',
    'release_control.py',
    'src/acceptance/phase5-fault-control-protocol.js',
    'src/capture/capture-wire.js',
    'src/capture/phase5-capture-proof.js',
    'validate_phase5_acceptance.py',
    'verify-candidate.sh',
    'verify-smoke.mjs',
  ];
  const valid = fixture();
  valid.deployExecutionIdentity = Object.fromEntries(
    names.map((name, index) => [name, String(index + 1).repeat(64).slice(0, 64)]),
  );
  const trusted = await readTrustedFixture(await writeFixture(valid));
  assert.equal(
    trusted.deployExecutionIdentity['legacy-lease.mjs'],
    valid.deployExecutionIdentity['legacy-lease.mjs'],
  );
  assert.ok(Object.isFrozen(trusted.deployExecutionIdentity));

  for (const mutate of [
    (identity) => { delete identity['legacy-lease.mjs']; },
    (identity) => { delete identity['phase5_candidate_attempt.py']; },
    (identity) => { delete identity['phase5_candidate_bootstrap.py']; },
    (identity) => {
      delete identity[
        'phase5-browser-preflight/flock-voice-engine/runtime/test/e2e/phase5-local.spec.js'
      ];
    },
    (identity) => {
      delete identity['phase5-summary/phase5_capture_channel_client.py'];
    },
    (identity) => {
      identity['phase5_capture_channel_client.py'] = (
        identity['phase5-summary/phase5_capture_channel_client.py']
      );
      delete identity['phase5-summary/phase5_capture_channel_client.py'];
    },
    (identity) => {
      identity['phase5-summary/phase5_capture_channel_client.py'] = 'A'.repeat(64);
    },
    (identity) => { identity['legacy_lease.mjs'] = identity['legacy-lease.mjs']; },
    (identity) => { identity['legacy-lease.mjs'] = 'A'.repeat(64); },
  ]) {
    const invalid = fixture();
    invalid.deployExecutionIdentity = { ...valid.deployExecutionIdentity };
    mutate(invalid.deployExecutionIdentity);
    await assert.rejects(
      readTrustedFixture(await writeFixture(invalid)),
      /RELEASE_MANIFEST_DEPLOY_EXECUTION_IDENTITY_INVALID/,
    );
  }
});
