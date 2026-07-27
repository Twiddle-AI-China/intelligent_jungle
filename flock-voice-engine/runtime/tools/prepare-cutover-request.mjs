#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]);
  return pairs;
}, []));
if (!args['release-dir'] || !args['runtime-root'] || !args.output
    || args['state-policy'] !== 'reset-new-world') {
  throw new Error('PREPARE_CUTOVER_ARGUMENTS_INVALID');
}
const runtimeRoot = resolve(args['runtime-root']);
const fromRuntime = (relative) => import(pathToFileURL(resolve(runtimeRoot, relative)));
const [{ DOMAIN_CONFIG }, { createSimulationKernelFactory }, { projectAudioState },
  { WorldSession }] = await Promise.all([
  fromRuntime('src/domain/config.js'), fromRuntime('src/simulation-runtime.js'),
  fromRuntime('src/audio/audio-state-projector.js'),
  fromRuntime('src/world-session/world-session.js'),
]);
const INITIAL_WORLD_SEED = 0x4c4353;
const releaseDir = resolve(args['release-dir']);
const manifestBytes = await readFile(`${releaseDir}/release-manifest.json`);
const manifest = JSON.parse(manifestBytes);
const createKernel = createSimulationKernelFactory({ enableLatent: false });
const session = new WorldSession({ seed: INITIAL_WORLD_SEED, createKernel,
  validateRestoredSnapshot: () => false,
  releaseRevision: manifest.workerIdentity.releaseRevision });

// This is a real owner commit, not a DTO initializer or injected generation factory.
await session.commit('initial-world', (owner) => owner.kernel.tick(1 / DOMAIN_CONFIG.sim.tickHz));
const clientId = randomUUID();
const bootstrap = await session.readBootstrap({ clientId });
const frames = [];
const egress = { enqueue(frame) { frames.push(structuredClone(frame)); return true; }, close() {} };
await session.attach({ clientId, token: bootstrap.bootstrapToken,
  worldGeneration: bootstrap.worldGeneration, lastRevision: bootstrap.revision,
  lastEventSeq: bootstrap.eventSeq, egress, generation: 1 });
const barrier = await session.requestSnapshot({ clientId, generation: 1 });
if (barrier.accepted !== true) throw new Error('INITIAL_SNAPSHOT_BARRIER_FAILED');
const snapshotFrame = frames.findLast((frame) => frame.type === 'snapshot');
if (!snapshotFrame || snapshotFrame.worldGeneration !== bootstrap.worldGeneration
    || snapshotFrame.snapshot.worldGeneration !== bootstrap.worldGeneration) {
  throw new Error('INITIAL_WORLD_GENERATION_MISMATCH');
}
const stateReplace = { type: 'state.replace', value: projectAudioState({ session,
  audioOwner: 'world', ready: { audioEpoch: 'authorized-initial-world', renderFrame: 0n,
    geometry: manifest.geometry } }) };
if (stateReplace.value.world.worldGeneration !== bootstrap.worldGeneration) {
  throw new Error('INITIAL_STATE_REPLACE_GENERATION_MISMATCH');
}
const initialWorld = { schemaVersion: 1, worldId: session.worldId,
  worldGeneration: bootstrap.worldGeneration, protocolVersion: snapshotFrame.protocolVersion,
  revision: snapshotFrame.revision, eventSeq: snapshotFrame.eventSeq,
  snapshotSchemaVersion: snapshotFrame.snapshot.snapshotSchemaVersion,
  snapshot: snapshotFrame.snapshot };
const initialBytes = Buffer.from(canonical(initialWorld));
const safeBootstrap = { schemaVersion: 1, protocolVersion: bootstrap.protocolVersion,
  worldId: bootstrap.worldId, worldGeneration: bootstrap.worldGeneration,
  revision: bootstrap.revision, eventSeq: bootstrap.eventSeq, snapshot: bootstrap.snapshot };
await writeFile(`${releaseDir}/initial-world.json`, initialBytes, { flag: 'wx' });
await writeFile(`${releaseDir}/bootstrap.json`, canonical(safeBootstrap), { flag: 'wx' });
await writeFile(`${releaseDir}/state-replace.json`, canonical(stateReplace), { flag: 'wx' });
const acceptanceBytes = await readFile(`${releaseDir}/acceptance.json`);
const archiveBytes = await readFile(`${releaseDir}/release.tar.zst`);
const bootstrapBytes = await readFile(`${releaseDir}/import-release.sh`);
const request = {
  schemaVersion: 1,
  releaseRevision: manifest.workerIdentity.releaseRevision,
  sourceManifestSha256: manifest.workerIdentity.sourceManifestSha256,
  audioArtifactSha256: manifest.workerIdentity.audioArtifactSha256,
  runtimeImageDigest: manifest.imageIdentity.runtime,
  audioImageDigest: manifest.imageIdentity.audio,
  acceptanceSha256: digest(acceptanceBytes),
  releaseArchiveSha256: digest(archiveBytes),
  importBootstrapSha256: digest(bootstrapBytes),
  releaseManifestSha256: digest(manifestBytes),
  previousReleaseIdentity: 'production-read-only-preflight-required',
  stateMigrationPolicy: 'reset-new-world',
  newWorldId: session.worldId,
  newWorldGeneration: bootstrap.worldGeneration,
  initialWorldSha256: digest(initialBytes),
  initialWorld,
};
await writeFile(resolve(args.output), canonical(request), { flag: 'wx' });
await session.detach({ clientId, generation: 1 });
session.kernel.dispose?.();
