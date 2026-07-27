import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { createDecoderAdapter } from '../legacy/decoder-adapter.js';

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
      asset: `/assets/timbre/voice_maps/${voice}.json`, defaultK: 4,
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
  geometry, allowedOrigin, selfOrigin = 'http://127.0.0.1:18090',
  getPublicAudioStatus = () => audioOwner.getStatus(),
  webSocketServer = new WebSocketServer({ noServer: true, clientTracking: true }),
  createAdapter = createDecoderAdapter,
  readAsset = (name) => readFileSync(new URL(`../../../client/${name}`, import.meta.url)),
  readMapAsset = (name) => readFileSync(new URL(`../../../assets/timbre/voice_maps/${name}.json`,
    import.meta.url)),
} = {}) {
  if (!sessionRegistry || !audioOwner || !planner || !masterRing || !splitRing || !geometry
      || typeof allowedOrigin !== 'string') {
    throw new Error('LEGACY_ROUTES_DEPENDENCIES_REQUIRED');
  }
  const backend = compatibilityBackend(geometry, readMapAsset);
  const exactOrigins = new Set([allowedOrigin, selfOrigin]);
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
    handleHttp(request, response) {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && pathname === '/api/decoder-status') {
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
      if (['GET', 'POST'].includes(request.method) && pathname === '/api/load') {
        sendJson(response, 200, { loaded: true, backend: 'backend-owned-runtime' }); return true;
      }
      const assets = new Map([['/', 'demo.html'], ['/demo.html', 'demo.html'],
        ['/tracks.html', 'tracks.html'], ['/voice-client.js', 'voice-client.js'],
        ['/pcm-player-worklet.js', 'pcm-player-worklet.js']]);
      if (request.method === 'GET' && assets.has(pathname)) {
        try {
          const name = assets.get(pathname); const body = readAsset(name);
          response.writeHead(200, { 'content-type': name.endsWith('.html')
            ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8',
          'content-length': body.length }); response.end(body);
        } catch { sendJson(response, 404, { error: 'NOT_FOUND' }); }
        return true;
      }
      const mapMatch = /^\/assets\/timbre\/voice_maps\/([a-z]+)\.json$/.exec(pathname);
      if (request.method === 'GET' && mapMatch && Object.hasOwn(backend.voices, mapMatch[1])) {
        try {
          const body = readMapAsset(mapMatch[1]);
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
            'content-length': body.length }); response.end(body);
        } catch { sendJson(response, 404, { error: 'NOT_FOUND' }); }
        return true;
      }
      return false;
    },
    handleUpgrade(request, socket, head) {
      if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/decoder') return false;
      if (!exactOrigins.has(request.headers.origin)) { socket.destroy?.(); return true; }
      webSocketServer.handleUpgrade(request, socket, head,
        (client) => webSocketServer.emit('connection', client, request)); return true;
    },
    close: () => new Promise((resolve) => {
      for (const client of webSocketServer.clients ?? []) client.close?.(1001, 'RUNTIME_STOPPING');
      try { webSocketServer.close(resolve); } catch { resolve(); }
    }),
  });
}
