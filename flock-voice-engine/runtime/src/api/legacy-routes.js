import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { createDecoderAdapter } from '../legacy/decoder-adapter.js';
import {
  writeOriginPolicyHttpFailure,
  writeOriginPolicyUpgradeFailure,
} from './origin-policy.js';

const VOICE_MAP_ASSETS = Object.freeze({
  bass: new URL('../../../assets/timbre/voice_maps/bass.json', import.meta.url),
  pad: new URL('../../../assets/timbre/voice_maps/pad.json', import.meta.url),
  lead: new URL('../../../assets/timbre/voice_maps/lead.json', import.meta.url),
  pluck: new URL('../../../assets/timbre/voice_maps/pluck.json', import.meta.url),
});
const VOICE_MAP_PATHS = Object.freeze({
  bass: '/assets/timbre/voice_maps/bass.json',
  pad: '/assets/timbre/voice_maps/pad.json',
  lead: '/assets/timbre/voice_maps/lead.json',
  pluck: '/assets/timbre/voice_maps/pluck.json',
});

function readKnownAsset(table, name) {
  if (!Object.hasOwn(table, name)) throw new Error('LEGACY_ASSET_UNKNOWN');
  return readFileSync(table[name]);
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body) }); response.end(body);
}

function compatibilityBackend(geometry, readMapAsset) {
  const productionRows = ['bass', 'pad', 'lead', 'pluck', 'pad'];
  const geometryCompatible = geometry.rowVoices?.length === productionRows.length
    && geometry.rowVoices.every((voice, row) => voice === productionRows[row]);
  const rowsBySpecies = {};
  for (const [row, voice] of (geometry.rowVoices ?? []).entries()) {
    (rowsBySpecies[voice] ??= []).push(row);
  }
  const maps = new Map();
  if (geometryCompatible) {
    for (const voice of Object.keys(rowsBySpecies)) {
      try {
        const value = JSON.parse(readMapAsset(voice).toString('utf8'));
        if (value.voice !== voice || !Array.isArray(value.points) || value.points.length === 0
            || typeof value.layout !== 'string' || !Number.isFinite(value.scale)) {
          throw new Error('LEGACY_VOICE_MAP_INVALID');
        }
        maps.set(voice, value);
      } catch { maps.clear(); break; }
    }
  }
  const compatible = geometryCompatible && maps.size === Object.keys(rowsBySpecies).length;
  const voices = Object.fromEntries(Object.entries(rowsBySpecies).map(([voice, rows]) => [voice, {
    row: rows[0], gain: 1, step: maps.get(voice)?.checkpointStep ?? null,
    configHash: maps.get(voice)?.configHash ?? null,
    engine: voice === 'pad' ? 'trajectorybrave-v1' : 'midibrave-v2',
    roam: compatible ? { available: true, points: maps.get(voice).points.length,
      layout: maps.get(voice).layout, scale: maps.get(voice).scale,
      asset: VOICE_MAP_PATHS[voice], defaultK: 4,
      pca: maps.get(voice).pca_basis ? { available: true,
        dims: maps.get(voice).pca_basis.dims,
        ranges: maps.get(voice).pca_basis.ranges,
        explainedTotal: maps.get(voice).pca_basis.explained_total } : { available: false, dims: 0 },
    } : { available: false, points: 0 },
  }]));
  return Object.freeze({ id: compatible ? 'brave-voices' : 'backend-owned-runtime',
    engine: compatible ? 'midibrave-v2-voices' : 'backend-owned-runtime',
    loaded: compatible, sampleRate: geometry.sampleRate, blockSamples: geometry.blockFrames,
    poolSize: geometry.poolSize, latentSize: compatible ? 256 : null,
    rowVoices: [...(geometry.rowVoices ?? [])], rowsBySpecies,
    voices, roamSupported: compatible, pendingVoices: [] });
}

export function createLegacyRoutes({ sessionRegistry, audioOwner, planner, masterRing, splitRing,
  geometry, originPolicy,
  getPublicAudioStatus = () => audioOwner.getStatus(),
  webSocketServer = new WebSocketServer({ noServer: true, clientTracking: true }),
  createAdapter = createDecoderAdapter,
  readMapAsset = (name) => readKnownAsset(VOICE_MAP_ASSETS, name),
} = {}) {
  if (!sessionRegistry || !audioOwner || !planner || !masterRing || !splitRing || !geometry
      || typeof originPolicy?.authorize !== 'function') {
    throw new Error('LEGACY_ROUTES_DEPENDENCIES_REQUIRED');
  }
  const backend = compatibilityBackend(geometry, readMapAsset);
  webSocketServer.on('connection', (socket, request) => {
    const split = new URL(request.url ?? '/decoder', 'http://127.0.0.1').searchParams.get('split') === '1';
    let session; let adapter;
    try {
      session = { ...sessionRegistry.attach(socket, { split }), backend };
      adapter = createAdapter({ socket, session, audioOwner, planner, masterRing, splitRing, geometry });
      adapter.start();
    } catch {
      adapter?.stop?.();
      if (session) {
        sessionRegistry.detach(session.decoderSessionId);
        Promise.resolve(audioOwner.decoderDisconnected(session.decoderSessionId)).catch(() => {});
      }
      socket.close?.(1011, 'LEGACY_ATTACH_FAILED'); return;
    }
    socket.on('message', (data, binary) => {
      try {
        if (binary) throw new Error('LEGACY_JSON_REQUIRED');
        adapter.route(JSON.parse(data.toString('utf8')));
      } catch { socket.close?.(4400, 'LEGACY_FRAME_INVALID'); }
    });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      adapter.stop(); sessionRegistry.detach(session.decoderSessionId);
      Promise.resolve(audioOwner.decoderDisconnected(session.decoderSessionId)).catch(() => {});
    };
    socket.once('close', cleanup); socket.once('error', cleanup);
  });
  return Object.freeze({
    originPolicy,
    handleHttp(request, response) {
      const requestTarget = request.url ?? '/';
      if (request.method === 'GET' && requestTarget === '/api/decoder-status') {
        const decision = originPolicy.authorize('compatRead', request);
        if (decision.allowed !== true) {
          writeOriginPolicyHttpFailure(response, decision);
          return true;
        }
        const ownerStatus = audioOwner.getStatus();
        const publicStatus = getPublicAudioStatus();
        const consistent = ownerStatus.audioOwner === publicStatus.audioOwner;
        sendJson(response, 200, { loaded: true, backend: 'backend-owned-runtime',
          engine: 'flock-voice-engine', defaultModel: backend.id, models: [backend],
          sampleRate: geometry.sampleRate, blockSamples: geometry.blockFrames,
          samplesPerFrame: geometry.blockFrames, framesPerDecode: 1,
          poolSize: geometry.poolSize, splitSupported: true, splitChannels: geometry.poolSize,
          channels: 2, pcmFormat: 'f32-interleaved-stereo',
          controlSchemes: ['control', 'note'], timbres: ['bass', 'pad', 'lead', 'pluck'],
          serverSideMastering: false,
          audioOwner: publicStatus.audioOwner,
          decoderSessionId: consistent ? ownerStatus.decoderSessionId : null,
          expiresAt: consistent ? ownerStatus.expiresAt : null }); return true;
      }
      if (['GET', 'POST'].includes(request.method) && requestTarget === '/api/load') {
        const surface = request.method === 'GET' ? 'compatRead' : 'compatWrite';
        const decision = originPolicy.authorize(surface, request);
        if (decision.allowed !== true) {
          writeOriginPolicyHttpFailure(response, decision);
          return true;
        }
        sendJson(response, 200, { loaded: true, backend: 'backend-owned-runtime' }); return true;
      }
      return false;
    },
    handleUpgrade(request, socket, head) {
      const requestTarget = request.url ?? '/';
      if (requestTarget !== '/decoder' && requestTarget !== '/decoder?split=1') return false;
      const decision = originPolicy.authorize('websocket', request);
      if (decision.allowed !== true) {
        writeOriginPolicyUpgradeFailure(socket, decision);
        return true;
      }
      webSocketServer.handleUpgrade(request, socket, head,
        (client) => webSocketServer.emit('connection', client, request)); return true;
    },
    close: () => new Promise((resolve) => {
      for (const client of webSocketServer.clients ?? []) client.close?.(1001, 'RUNTIME_STOPPING');
      try { webSocketServer.close(resolve); } catch { resolve(); }
    }),
  });
}
