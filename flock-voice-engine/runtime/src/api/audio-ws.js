import { WebSocketServer } from 'ws';
import { createAudioClientWriter } from '../audio/audio-client-writer.js';
import { writeOriginPolicyUpgradeFailure } from './origin-policy.js';

export function createAudioWsGateway({ ring, originPolicy, getAudioReady,
  webSocketServer = new WebSocketServer({ noServer: true, clientTracking: true }),
  createWriter = createAudioClientWriter,
  faultClientRegistry = null,
  getFaultClientRegistry = null,
  faultTransportRecorder = null,
  onFaultReconnectGrant = null,
  getFaultClientActuator = null } = {}) {
  if (!ring || typeof originPolicy?.authorize !== 'function'
      || typeof getAudioReady !== 'function'
      || !(faultClientRegistry === null || (
        typeof faultClientRegistry?.claim === 'function'
        && typeof faultClientRegistry?.close === 'function'
      ))
      || !(getFaultClientRegistry === null
        || typeof getFaultClientRegistry === 'function')
      || (faultClientRegistry !== null && getFaultClientRegistry !== null)
      || !(faultTransportRecorder === null || [
        'audioOpen', 'audioReady', 'audioPcm',
        'audioDiscontinuity', 'audioClose',
      ].every((name) => typeof faultTransportRecorder?.[name] === 'function'))
      || !(onFaultReconnectGrant === null
        || typeof onFaultReconnectGrant === 'function')
      || !(getFaultClientActuator === null
        || typeof getFaultClientActuator === 'function')) {
    throw new Error('AUDIO_WS_DEPENDENCIES_REQUIRED');
  }
  webSocketServer.on('connection', (
    socket,
    _request,
    faultClaim = null,
    claimRegistry = faultClientRegistry,
  ) => {
    let writer = null;
    let faultGrantReleased = false;
    let faultCloseRecorded = false;
    let faultActuator = null;
    let faultActuatorRegistered = false;
    const close = (code = 1006, reason = '') => {
      writer?.stop();
      if (faultActuatorRegistered) {
        faultActuatorRegistered = false;
        try { faultActuator.unregisterAudio(faultClaim); } catch {}
      }
      if (faultClaim !== null && !faultCloseRecorded
          && faultTransportRecorder !== null) {
        faultCloseRecorded = true;
        try {
          faultTransportRecorder.audioClose(faultClaim, {
            code: Number.isSafeInteger(code) ? code : 1006,
            reason: typeof reason === 'string'
              ? reason : Buffer.from(reason ?? '').toString('utf8'),
          });
        } catch {
          try { socket.terminate?.(); } catch {}
        }
      }
      if (faultClaim === null || faultGrantReleased) return;
      faultGrantReleased = true;
      try {
        const next = claimRegistry.close({
          client: faultClaim.client,
          socketKind: 'audio',
          generation: faultClaim.generation,
        });
        onFaultReconnectGrant?.(next);
      } catch {
        // The registry remains fail-closed after a mismatched lifecycle.
      }
    };
    socket.on('close', close);
    socket.on('error', () => close(1011, 'AUDIO_SOCKET_ERROR'));
    try {
      if (faultClaim !== null && faultTransportRecorder !== null) {
        faultTransportRecorder.audioOpen(faultClaim);
      }
      const observer = faultClaim === null || faultTransportRecorder === null
        ? null : {
          ready(value) {
            faultTransportRecorder.audioReady(faultClaim, {
              audioEpoch: value.audioEpoch,
              streamRevision: value.streamRevision,
              blockSeq: value.blockSeq,
              resumeStartFrame: value.resumeStartFrame,
            });
          },
          pcm(value) {
            faultTransportRecorder.audioPcm(faultClaim, value);
          },
          discontinuity(value) {
            faultTransportRecorder.audioDiscontinuity(faultClaim, {
              audioEpoch: value.audioEpoch,
              streamRevision: value.streamRevision,
              blockSeq: value.blockSeq,
              resumeStartFrame: value.resumeStartFrame,
              scope: value.scope,
            });
          },
        };
      writer = createWriter({ socket, ring, getAudioReady, observer });
      writer.start();
      if (faultClaim?.client === 4 && getFaultClientActuator !== null) {
        faultActuator = getFaultClientActuator();
        if (!['registerAudio', 'unregisterAudio'].every(
          (name) => typeof faultActuator?.[name] === 'function')) {
          throw new Error('PHASE5_CLIENT_ACTUATOR_UNAVAILABLE');
        }
        faultActuator.registerAudio(faultClaim);
        faultActuatorRegistered = true;
      }
    }
    catch {
      close(1011, 'AUDIO_NOT_READY');
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
      let faultClaim = null;
      let claimRegistry = faultClientRegistry;
      if (getFaultClientRegistry !== null) {
        try {
          claimRegistry = getFaultClientRegistry();
        } catch {
          socket.destroy?.();
          return true;
        }
        if (!(claimRegistry === null || (
          typeof claimRegistry?.claim === 'function'
          && typeof claimRegistry?.close === 'function'
        ))) {
          socket.destroy?.();
          return true;
        }
      }
      if (claimRegistry !== null) {
        const capability = request.headers?.[
          'x-flock-phase5-client-capability'
        ];
        if (typeof capability !== 'string') {
          socket.destroy?.();
          return true;
        }
        try {
          faultClaim = claimRegistry.claim({
            socketKind: 'audio',
            capability,
          });
        } catch {
          socket.destroy?.();
          return true;
        }
      }
      webSocketServer.handleUpgrade(request, socket, head,
        (client) => webSocketServer.emit(
          'connection',
          client,
          request,
          faultClaim,
          claimRegistry,
        ));
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
