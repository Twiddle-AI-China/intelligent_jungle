import { createAudioWsGateway } from '../../src/api/audio-ws.js';
import { createPublicAudioStatusStore } from '../../src/audio/public-audio-status.js';
import { createPcmRing } from '../../src/audio/pcm-ring.js';
import { PHASE_CONFIG } from '../../src/config.js';
import { createRuntimeApp, PHASE_2_SHADOW_SEED } from '../../src/runtime-app.js';

const audio = Object.freeze({ audioEpoch: 'phase5-e2e', manifestGeometrySha256: 'a'.repeat(64),
  sampleRate: 6400, blockFrames: 64, channels: 2, format: 'f32le',
  binaryHeaderVersion: 1, headerBytes: 32 });
const ring = createPcmRing({ sampleRate: audio.sampleRate, blockFrames: audio.blockFrames });
ring.beginStream({ audioEpoch: audio.audioEpoch, minStartFrame: 0n });
for (let block = 0; block < 8; block += 1) {
  ring.publish({ startFrame: BigInt(block * audio.blockFrames), frameCount: audio.blockFrames,
    channels: 2, format: 1, payload: Buffer.alloc(audio.blockFrames * 2 * 4) });
}
const audioStatusStore = createPublicAudioStatusStore();
await audioStatusStore.update({ runtimeOwner: 'server', audioOwner: 'world', workerReady: true,
  recovering: false, degraded: false, degradedReason: null, audio });
const audioGateway = createAudioWsGateway({ ring, allowedOrigin: PHASE_CONFIG.allowedOrigin,
  getAudioReady: () => audio });

const legacyRoutes = Object.freeze({
  handleHttp: () => false,
  handleUpgrade(_request, socket) { socket.destroy(); return true; },
  close: async () => {},
});
const app = createRuntimeApp({
  runtimeConfig: PHASE_CONFIG,
  releaseInfo: Object.freeze({ releaseRevision: 'phase5-e2e',
    sourceManifestSha256: 'b'.repeat(64), runtimeOwner: 'server', audioOwner: 'world' }),
  seed: PHASE_2_SHADOW_SEED,
  audioStatusStore,
  audioGateway,
  audioSupervisor: Object.freeze({ start() {}, stop() {},
    getStatus: () => ({ workerReady: true }) }),
  legacyRoutes,
});

await app.start();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await app.stop(); process.exitCode = 0; });
}
