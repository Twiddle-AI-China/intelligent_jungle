import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, parse, resolve, sep } from 'node:path';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;

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
    if (current.isSymbolicLink() || !sameStat(snapshot.value, current)) {
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
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== 1
      || Object.keys(value).sort().join(',') !== [
        'schemaVersion', 'workerIdentity', 'geometry', 'manifestGeometrySha256',
        'baseImages', 'imageIdentity',
      ].sort().join(',')) {
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
}

const productionFdReader = Object.freeze({ open, lstat });

export async function readTrustedReleaseManifest({ path, digestPath, fdReader = productionFdReader }) {
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
  const expectedSidecar = `${createHash('sha256').update(manifestBytes).digest('hex')}  ${basename(path)}\n`;
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
  return Object.freeze({
    ...manifest,
    workerIdentity: Object.freeze({ ...manifest.workerIdentity }),
    geometry: Object.freeze({ ...manifest.geometry, rowVoices: Object.freeze([...manifest.geometry.rowVoices]) }),
    baseImages: Object.freeze({ runtime: Object.freeze({ ...manifest.baseImages.runtime }), audio: Object.freeze({ ...manifest.baseImages.audio }) }),
    imageIdentity: Object.freeze({ ...manifest.imageIdentity }),
  });
}
