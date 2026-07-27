const FIELDS = Object.freeze([
  ['releaseRevision', 'WORKER_IDENTITY_RELEASE_MISMATCH'],
  ['sourceManifestSha256', 'WORKER_IDENTITY_SOURCE_MANIFEST_MISMATCH'],
  ['protocolFamily', 'WORKER_IDENTITY_PROTOCOL_FAMILY_MISMATCH'],
  ['protocolVersion', 'WORKER_IDENTITY_PROTOCOL_VERSION_MISMATCH'],
  ['audioArtifactKind', 'WORKER_IDENTITY_ARTIFACT_KIND_MISMATCH'],
  ['audioArtifactSha256', 'WORKER_IDENTITY_AUDIO_ARTIFACT_MISMATCH'],
]);

export function compareWorkerIdentity(expected, reported) {
  for (const [field, reason] of FIELDS) {
    if (reported?.[field] !== expected?.[field]) return { ok: false, reason };
  }
  return { ok: true, reason: null };
}

export function assertExactWorkerIdentity(expected, reported) {
  const result = compareWorkerIdentity(expected, reported);
  if (!result.ok) throw new Error(result.reason);
}
