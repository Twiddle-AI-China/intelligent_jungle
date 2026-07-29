import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { createAudioWsGateway } from '../../src/api/audio-ws.js';
import {
  authorizeExactIpv4LoopbackTransport,
  createOriginPolicy,
  writeOriginPolicyUpgradeFailure,
} from '../../src/api/origin-policy.js';
import { createPublicAudioStatusStore } from '../../src/audio/public-audio-status.js';
import { createPcmRing } from '../../src/audio/pcm-ring.js';
import { createRuntimeApp, PHASE_2_SHADOW_SEED } from '../../src/runtime-app.js';
import {
  listenLoopbackPortMap,
  loadFixtureProductionStaticUi,
} from './e2e-runtime-host.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const opsAuthorities = Object.freeze(['127.0.0.1:8090']);
const runtimeConfig = Object.freeze({
  host: '127.0.0.1',
  port: 8090,
  canonicalOrigin: 'http://127.0.0.1:18090',
  opsAuthorities,
  runtimeOwner: 'server',
  audioOwner: 'world',
  phaseGate: 'phase5-local',
});
const originPolicy = createOriginPolicy({
  canonicalOrigin: runtimeConfig.canonicalOrigin,
  opsAuthorities,
  authorizeOperationalTransport: authorizeExactIpv4LoopbackTransport,
});
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
const audioGateway = createAudioWsGateway({ ring, originPolicy,
  getAudioReady: () => audio });

const legacyWebSocketServer = new WebSocketServer({ noServer: true, clientTracking: true });
legacyWebSocketServer.on('connection', (socket) => {
  socket.send(JSON.stringify({
    type: 'legacy.session',
    decoderSessionId: 'decoder-phase5-fixture',
    readOnly: true,
  }));
  socket.on('message', () => socket.send(JSON.stringify({
    type: 'error',
    code: 'LEGACY_LEASE_REQUIRED',
    message: 'legacy audio is read-only until an operator grants the exact decoder lease',
  })));
});
const legacyRoutes = Object.freeze({
  originPolicy,
  handleHttp: () => false,
  handleUpgrade(request, socket, head) {
    if (!['/decoder', '/decoder?split=1'].includes(request.url)) return false;
    const decision = originPolicy.authorize('websocket', request);
    if (decision.allowed !== true) {
      writeOriginPolicyUpgradeFailure(socket, decision);
      return true;
    }
    legacyWebSocketServer.handleUpgrade(request, socket, head,
      (client) => legacyWebSocketServer.emit('connection', client, request));
    return true;
  },
  close: () => new Promise((done) => {
    for (const client of legacyWebSocketServer.clients) {
      try { client.close(1001, 'RUNTIME_STOPPING'); } catch { client.terminate(); }
    }
    try { legacyWebSocketServer.close(done); } catch { done(); }
  }),
});
const productionStatic = await loadFixtureProductionStaticUi({ repoRoot, originPolicy });
const app = createRuntimeApp({
  runtimeConfig,
  originPolicy,
  releaseInfo: Object.freeze({ releaseRevision: 'phase5-e2e',
    sourceManifestSha256: 'b'.repeat(64), runtimeOwner: 'server', audioOwner: 'world' }),
  seed: PHASE_2_SHADOW_SEED,
  audioStatusStore,
  audioGateway,
  audioSupervisor: Object.freeze({ start() {}, stop() {},
    getStatus: () => ({ workerReady: true }) }),
  legacyRoutes,
  staticUi: productionStatic.staticUi,
});

const portMap = await listenLoopbackPortMap();
try {
  await app.start();
} catch (error) {
  await portMap.close();
  await productionStatic.close();
  throw error;
}
let stopping = null;
function stop() {
  if (stopping === null) {
    stopping = Promise.allSettled([
      portMap.close(),
      app.stop(),
    ]).then(() => productionStatic.close());
  }
  return stopping;
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await stop(); process.exitCode = 0; });
}
