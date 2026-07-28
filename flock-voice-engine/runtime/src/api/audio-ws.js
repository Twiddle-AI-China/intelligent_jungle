import { WebSocketServer } from 'ws';
import { createAudioClientWriter } from '../audio/audio-client-writer.js';
import { writeOriginPolicyUpgradeFailure } from './origin-policy.js';

export function createAudioWsGateway({ ring, originPolicy, getAudioReady,
  webSocketServer = new WebSocketServer({ noServer: true, clientTracking: true }),
  createWriter = createAudioClientWriter } = {}) {
  if (!ring || typeof originPolicy?.authorize !== 'function'
      || typeof getAudioReady !== 'function') {
    throw new Error('AUDIO_WS_DEPENDENCIES_REQUIRED');
  }
  webSocketServer.on('connection', (socket) => {
    let writer = null;
    socket.on('close', () => writer?.stop()); socket.on('error', () => writer?.stop());
    try { writer = createWriter({ socket, ring, getAudioReady }); writer.start(); }
    catch {
      writer?.stop();
      socket.close?.(1011, 'AUDIO_NOT_READY');
    }
  });
  return Object.freeze({
    originPolicy,
    handleUpgrade(request, socket, head) {
      const requestTarget = request.url ?? '/';
      if (requestTarget !== '/api/v1/audio') {
        socket.destroy?.(); return false;
      }
      const decision = originPolicy.authorize('websocket', request);
      if (decision.allowed !== true) {
        writeOriginPolicyUpgradeFailure(socket, decision);
        return true;
      }
      webSocketServer.handleUpgrade(request, socket, head,
        (client) => webSocketServer.emit('connection', client, request));
      return true;
    },
    close: () => new Promise((resolve) => {
      for (const client of webSocketServer.clients ?? []) {
        try { client.close?.(1001, 'RUNTIME_STOPPING'); } catch { client.terminate?.(); }
      }
      try { webSocketServer.close(() => resolve()); } catch { resolve(); }
    }),
  });
}
