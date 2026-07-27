import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTrustedReleaseManifest } from '../../src/audio/release-manifest.js';

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

test('expected worker identity comes from one trusted manifest read', async () => {
  const paths = await writeFixture();
  const trusted = await readTrustedReleaseManifest(paths);
  assert.deepEqual(trusted.workerIdentity, fixture().workerIdentity);
  assert.ok(Object.isFrozen(trusted.workerIdentity));
});

test('symlink and group-writable manifest paths fail closed', async () => {
  const paths = await writeFixture();
  const link = join(paths.root, 'linked.json');
  await symlink(paths.path, link);
  await assert.rejects(readTrustedReleaseManifest({ path: link, digestPath: paths.digestPath }),
    /RELEASE_MANIFEST_UNTRUSTED_PATH/);
  await chmod(paths.path, 0o620);
  await assert.rejects(readTrustedReleaseManifest(paths), /RELEASE_MANIFEST_UNTRUSTED_PATH/);
});

test('a symlinked ancestor cannot redirect the trusted identity pair', async () => {
  const paths = await writeFixture();
  const safe = join(paths.root, 'safe');
  await symlink(paths.root, safe, 'dir');
  await assert.rejects(readTrustedReleaseManifest({
    path: join(safe, 'release-manifest.json'),
    digestPath: join(safe, 'release-manifest.json.sha256'),
  }), /RELEASE_MANIFEST_UNTRUSTED_PATH/);
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
  await assert.rejects(readTrustedReleaseManifest(badDigest), /RELEASE_MANIFEST_DIGEST_MISMATCH/);

  const schema = fixture();
  schema.unexpected = true;
  await assert.rejects(readTrustedReleaseManifest(await writeFixture(schema)), /RELEASE_MANIFEST_SCHEMA_INVALID/);

  const geometry = fixture();
  geometry.geometry.sampleRate = 0;
  geometry.manifestGeometrySha256 = createHash('sha256').update(canonical(geometry.geometry)).digest('hex');
  await assert.rejects(readTrustedReleaseManifest(await writeFixture(geometry)), /RELEASE_MANIFEST_GEOMETRY_INVALID/);

  const image = fixture();
  image.imageIdentity.audio = 'latest';
  await assert.rejects(readTrustedReleaseManifest(await writeFixture(image)), /RELEASE_MANIFEST_IMAGE_IDENTITY_INVALID/);
});

test('non-canonical manifest bytes are rejected even with a matching sidecar', async () => {
  const paths = await writeFixture();
  const body = Buffer.from(JSON.stringify(fixture(), null, 2));
  await writeFile(paths.path, body, { mode: 0o600 });
  const digest = createHash('sha256').update(body).digest('hex');
  await writeFile(paths.digestPath, `${digest}  release-manifest.json\n`, { mode: 0o600 });
  await assert.rejects(readTrustedReleaseManifest(paths), /RELEASE_MANIFEST_NOT_CANONICAL/);
});
