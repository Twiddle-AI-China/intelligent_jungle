const RELEASE_REVISION_PATTERN = /^[0-9a-f]{40}$/i;
const SOURCE_MANIFEST_PATTERN = /^[0-9a-f]{64}$/i;

export function loadReleaseInfo(env = process.env) {
  const releaseRevision = env.FLOCK_RELEASE_REVISION;
  const sourceManifestSha256 = env.FLOCK_SOURCE_MANIFEST_SHA256;
  const isUnknownPair = releaseRevision === 'unknown' && sourceManifestSha256 === 'unknown';
  const isPinnedPair = RELEASE_REVISION_PATTERN.test(releaseRevision ?? '')
    && SOURCE_MANIFEST_PATTERN.test(sourceManifestSha256 ?? '');

  if (!isUnknownPair && !isPinnedPair) {
    throw new Error('RELEASE_IDENTITY_PAIR_REQUIRED');
  }

  return {
    releaseRevision,
    sourceManifestSha256,
    protocolFamily: 'flock-runtime',
    protocolVersion: 1,
    runtimeOwner: 'browser',
    audioOwner: 'legacy',
  };
}
