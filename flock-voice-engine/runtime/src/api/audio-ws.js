import { WebSocketServer } from 'ws';
import { createAudioClientWriter } from '../audio/audio-client-writer.js';

export function createAudioWsGateway({ ring, allowedOrigin, getAudioReady,
  webSocketServer = new WebSocketServer({ noServer: true, clientTracking: true }),
  createWriter = createAudioClientWriter } = {}) {
  if (!ring || typeof allowedOrigin !== 'string' || typeof getAudioReady !== 'function') {
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
    handleUpgrade(request, socket, head) {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname !== '/api/v1/audio' || request.headers?.origin !== allowedOrigin) {
        socket.destroy?.(); return false;
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
