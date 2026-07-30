import { WebSocketServer } from 'ws';

import { createConnectionEgress } from './connection-egress.js';
import { writeOriginPolicyUpgradeFailure } from './origin-policy.js';
import { MAINTENANCE_COMMANDS, PROTOCOL_VERSION,
  normalizeMaintenanceCommandPayload } from '../protocol/v1.js';
import { requiresGatewayDelivery } from '../world-session/world-session.js';

let lastSocketGeneration = 0;

function nextSocketGeneration() {
  if (lastSocketGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error('SOCKET_GENERATION_EXHAUSTED');
  }
  lastSocketGeneration += 1;
  return lastSocketGeneration;
}

function parseFrame(data, isBinary) {
  if (isBinary) throw new Error('JSON_FRAME_REQUIRED');
  const frame = JSON.parse(data.toString('utf8'));
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new Error('JSON_OBJECT_REQUIRED');
  }
  return frame;
}

function validHello(frame) {
  return frame.type === 'hello'
    && frame.protocolVersion === PROTOCOL_VERSION
    && typeof frame.clientId === 'string'
    && frame.clientId.length > 0
    && typeof frame.worldGeneration === 'string'
    && frame.worldGeneration.length > 0
    && (typeof frame.bootstrapToken === 'string'
      || typeof frame.resumeToken === 'string');
}

export function createRuntimeWsGateway({
  getSession,
  originPolicy,
  egressCapacity = 256,
  createEgress = createConnectionEgress,
  webSocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
  }),
  audioStatusStore = null,
  maintenanceAuth = null,
  audioOwner = null,
  faultClientRegistry = null,
  getFaultClientRegistry = null,
  faultTransportRecorder = null,
  onFaultReconnectGrant = null,
  getFaultClientActuator = null,
}) {
  if (typeof getSession !== 'function' || typeof originPolicy?.authorize !== 'function') {
    throw new Error('RUNTIME_WS_DEPENDENCIES_REQUIRED');
  }
  if (!(faultClientRegistry === null || (
    typeof faultClientRegistry?.claim === 'function'
    && typeof faultClientRegistry?.close === 'function'
  )) || !(getFaultClientRegistry === null
    || typeof getFaultClientRegistry === 'function')
    || (faultClientRegistry !== null && getFaultClientRegistry !== null)
    || !(faultTransportRecorder === null || [
      'runtimeOpen', 'runtimeReady', 'runtimeSnapshot',
      'runtimeEgress', 'runtimeClose',
    ].every((name) => typeof faultTransportRecorder?.[name] === 'function'))
    || !(onFaultReconnectGrant === null
    || typeof onFaultReconnectGrant === 'function')
    || !(getFaultClientActuator === null
      || typeof getFaultClientActuator === 'function')) {
    throw new Error('RUNTIME_WS_DEPENDENCIES_REQUIRED');
  }

  async function routeCommand({
    session,
    clientId,
    generation,
    command,
    egress,
    faultClaim,
  }) {
    if (MAINTENANCE_COMMANDS.includes(command?.name)) {
      const payload = normalizeMaintenanceCommandPayload(command.name, command.payload);
      let outcome;
      if (!payload || command.type !== 'command' || command.protocolVersion !== PROTOCOL_VERSION
          || command.worldGeneration !== session.worldGeneration
          || typeof command.commandId !== 'string' || command.commandId.length === 0
          || !Number.isSafeInteger(command.baseRevision)
          || command.baseRevision < 0 || command.baseRevision > session.revision) {
        outcome = { accepted: false, code: 'INVALID_COMMAND' };
      } else if (!maintenanceAuth || !audioOwner) {
        outcome = { accepted: false, code: 'MAINTENANCE_UNAVAILABLE' };
      } else if (command.name === 'maintenance.authenticate') {
        const result = maintenanceAuth.authenticate({ credential: payload.credential, clientId,
          connectionGeneration: String(generation) });
        outcome = { accepted: result.ok, code: result.code,
          ...(result.maintenanceToken ? { maintenanceToken: result.maintenanceToken } : {}) };
      } else {
        const request = { ...payload, clientId, connectionGeneration: String(generation) };
        try {
          if (command.name === 'legacy.take') outcome = await audioOwner.takeLegacy(request);
          else if (command.name === 'legacy.heartbeat') outcome = audioOwner.heartbeat(request);
          else outcome = await audioOwner.releaseLegacy(request);
          outcome = { accepted: outcome.ok === true, ...outcome };
        } catch (error) {
          const known = new Set(['MAINTENANCE_AUTH_REQUIRED', 'LEGACY_DECODER_SESSION_GONE',
            'AUDIO_OWNER_TRANSITION_FAILED', 'AUDIO_CONTROL_TIMEOUT', 'AUDIO_REPLACE_TIMEOUT',
            'AUDIO_PCM_PRIME_TIMEOUT']);
          outcome = { accepted: false,
            code: known.has(error?.message) ? error.message : 'MAINTENANCE_COMMAND_FAILED' };
        }
      }
      const result = Object.freeze({ type: 'command.result', commandId: command.commandId,
        ...outcome });
      if (egress.enqueue(result) !== true) throw new Error('EGRESS_OVERFLOW');
      return null;
    }
    if (command?.name === 'snapshot.request') {
      const result = await session.requestSnapshot({
        clientId, generation, command,
      });
      return result;
    }
    return session.executeCommand({
      clientId,
      generation,
      command,
    });
  }

  function acceptConnection(
    socket,
    faultClaim = null,
    claimRegistry = faultClientRegistry,
  ) {
    let phase = 'awaiting-hello';
    let context = null;
    let cleanupPromise = null;
    let unsubscribeAudioStatus = null;
    let faultGrantReleased = false;
    let faultCloseRecorded = false;
    let faultActuator = null;
    let faultActuatorRegistered = false;

    function recordFaultClose(code, reason) {
      if (faultClaim === null || faultCloseRecorded
          || faultTransportRecorder === null) return;
      faultCloseRecorded = true;
      try {
        faultTransportRecorder.runtimeClose(faultClaim, {
          code: Number.isSafeInteger(code) ? code : 1006,
          reason: typeof reason === 'string'
            ? reason : Buffer.from(reason ?? '').toString('utf8'),
        });
      } catch {
        try { socket.terminate?.(); } catch {}
      }
    }

    function releaseFaultGrant() {
      if (faultClaim === null || faultGrantReleased) return;
      faultGrantReleased = true;
      try {
        const next = claimRegistry.close({
          client: faultClaim.client,
          socketKind: 'runtime',
          generation: faultClaim.generation,
        });
        onFaultReconnectGrant?.(next);
      } catch {
        // The registry remains fail-closed after a mismatched lifecycle.
      }
    }

    function ensureCleanup() {
      if (cleanupPromise) return cleanupPromise;
      unsubscribeAudioStatus?.(); unsubscribeAudioStatus = null;
      if (faultActuatorRegistered) {
        faultActuatorRegistered = false;
        try { faultActuator.unregisterRuntime(faultClaim); } catch {}
      }
      releaseFaultGrant();
      if (!context) return Promise.resolve(false);
      const { session, clientId, generation } = context;
      maintenanceAuth?.revokeConnection?.({ clientId, connectionGeneration: String(generation) });
      try {
        cleanupPromise = Promise.resolve(session.detach({
          clientId,
          generation,
        })).then(
          () => true,
          () => false,
        );
      } catch {
        cleanupPromise = Promise.resolve(false);
      }
      return cleanupPromise;
    }

    function closeProtocol(code, reason) {
      if (phase === 'closed' || phase === 'closing') {
        return ensureCleanup();
      }
      phase = 'closing';
      const cleanup = ensureCleanup();
      try {
        (context?.egress ?? socket).close(code, reason);
      } catch {
        socket.terminate?.();
      }
      return cleanup;
    }

    async function closeMessageFailure(error) {
      const overflow = error?.message === 'EGRESS_OVERFLOW';
      return closeProtocol(
        overflow ? 4410 : 1011,
        overflow ? 'EGRESS_OVERFLOW' : 'RUNTIME_MESSAGE_FAILED',
      );
    }

    socket.on('error', () => undefined);
    socket.on('close', async (code, reason) => {
      recordFaultClose(code, reason);
      phase = 'closed';
      return ensureCleanup();
    });

    socket.on('message', async (data, isBinary) => {
      try {
        let frame;
        try {
          frame = parseFrame(data, isBinary);
        } catch {
          closeProtocol(4400, 'JSON_FRAME_REQUIRED');
          return undefined;
        }

        if (phase === 'awaiting-hello') {
          phase = 'attaching';
          if (!validHello(frame)) {
            closeProtocol(4400, 'HELLO_REQUIRED');
            return undefined;
          }

          const clientId = faultClaim?.clientIdentitySha256
            ?? frame.clientId;
          const generation = faultClaim?.generation
            ?? nextSocketGeneration();
          const session = getSession('default');
          const egress = createEgress({
            socket,
            capacity: egressCapacity,
            onStateChange: faultClaim === null
              || faultTransportRecorder === null
              ? null
              : (value) => faultTransportRecorder.runtimeEgress(
                faultClaim,
                value,
              ),
            onDelivered: faultClaim === null
              || faultTransportRecorder === null
              ? null
              : (frame) => {
                if (frame?.type === 'snapshot') {
                  faultTransportRecorder.runtimeSnapshot(faultClaim, {
                    worldGeneration: frame.worldGeneration,
                    revision: frame.revision,
                    eventSeq: frame.eventSeq,
                  });
                }
              },
          });
          context = {
            clientId,
            generation,
            session,
            egress,
          };
          if (faultClaim !== null && faultTransportRecorder !== null) {
            faultTransportRecorder.runtimeOpen(faultClaim, {
              mode: faultClaim.generation === 1 ? 'bootstrap' : 'resume',
            });
          }

          try {
            let attachInput = {
              token: frame.bootstrapToken ?? frame.resumeToken,
              worldGeneration: frame.worldGeneration,
              lastRevision: frame.lastRevision,
              lastEventSeq: frame.lastEventSeq,
            };
            if (faultClaim?.generation === 1) {
              if (frame.bootstrapToken === undefined
                  || typeof session.readBootstrap !== 'function') {
                throw new Error('FAULT_BOOTSTRAP_REQUIRED');
              }
              const bootstrap = await session.readBootstrap({ clientId });
              const snapshotFrame = {
                type: 'snapshot',
                protocolVersion: PROTOCOL_VERSION,
                worldGeneration: bootstrap.worldGeneration,
                revision: bootstrap.revision,
                eventSeq: bootstrap.eventSeq,
                snapshot: bootstrap.snapshot,
              };
              if (egress.enqueue(snapshotFrame) !== true) {
                throw new Error('EGRESS_OVERFLOW');
              }
              attachInput = {
                token: bootstrap.bootstrapToken,
                worldGeneration: bootstrap.worldGeneration,
                lastRevision: bootstrap.revision,
                lastEventSeq: bootstrap.eventSeq,
              };
            } else if (faultClaim !== null
                && frame.resumeToken === undefined) {
              throw new Error('FAULT_RESUME_REQUIRED');
            }
            await session.attach({
              clientId,
              ...attachInput,
              egress,
              generation,
            });
          } catch {
            await closeProtocol(4401, 'ATTACH_REJECTED');
            return undefined;
          }

          if (phase !== 'attaching') {
            await ensureCleanup();
            return undefined;
          }
          phase = 'attached';
          if (faultClaim?.client === 4 && getFaultClientActuator !== null) {
            faultActuator = getFaultClientActuator();
            if (!['registerRuntime', 'unregisterRuntime'].every(
              (name) => typeof faultActuator?.[name] === 'function')) {
              throw new Error('PHASE5_CLIENT_ACTUATOR_UNAVAILABLE');
            }
            faultActuator.registerRuntime(faultClaim, Object.freeze({
              close: (code, reason) => socket.close(code, reason),
              enqueue: (frame) => egress.enqueue(frame),
            }));
            faultActuatorRegistered = true;
          }
          if (faultClaim !== null && faultTransportRecorder !== null) {
            faultTransportRecorder.runtimeReady(faultClaim, {
              worldGeneration: session.worldGeneration,
              revision: session.revision,
              eventSeq: session.eventSeq,
            });
          }
          if (audioStatusStore) {
            const sendStatus = (status) => {
              if (egress.enqueue({ type: 'audio.status', protocolVersion: PROTOCOL_VERSION, ...status }) !== true) {
                closeProtocol(4410, 'EGRESS_OVERFLOW');
              }
            };
            unsubscribeAudioStatus = audioStatusStore.subscribe(sendStatus, { replayCurrent: true });
          }
          egress.startWriter();
          return undefined;
        }

        if (phase === 'closing' || phase === 'closed') {
          const cleaned = await ensureCleanup();
          if (!cleaned || !context || frame.type !== 'command') {
            return undefined;
          }
          return await routeCommand({
            session: context.session,
            clientId: context.clientId,
            generation: context.generation,
            command: frame,
            egress: context.egress,
            faultClaim,
          });
        }

        if (!context || phase !== 'attached') {
          closeProtocol(4400, 'HELLO_REQUIRED');
          return undefined;
        }
        if (frame.type !== 'command') {
          closeProtocol(4400, 'COMMAND_REQUIRED');
          return undefined;
        }

        const result = await routeCommand({
          session: context.session,
          clientId: context.clientId,
          generation: context.generation,
          command: frame,
          egress: context.egress,
          faultClaim,
        });
        if (
          requiresGatewayDelivery(result)
          && context.egress.enqueue(result) !== true
        ) {
          await closeProtocol(4410, 'EGRESS_OVERFLOW');
        }
        return result;
      } catch (error) {
        await closeMessageFailure(error);
        return undefined;
      }
    });
  }

  function handleUpgrade(request, networkSocket, head) {
    const requestTarget = request.url ?? '/';
    if (requestTarget !== '/api/v1/runtime') {
      networkSocket.destroy?.();
      return false;
    }
    const decision = originPolicy.authorize('websocket', request);
    if (decision.allowed !== true) {
      writeOriginPolicyUpgradeFailure(networkSocket, decision);
      return true;
    }
    let faultClaim = null;
    let claimRegistry = faultClientRegistry;
    if (getFaultClientRegistry !== null) {
      try {
        claimRegistry = getFaultClientRegistry();
      } catch {
        networkSocket.destroy?.();
        return true;
      }
      if (!(claimRegistry === null || (
        typeof claimRegistry?.claim === 'function'
        && typeof claimRegistry?.close === 'function'
      ))) {
        networkSocket.destroy?.();
        return true;
      }
    }
    if (claimRegistry !== null) {
      const capability = request.headers?.[
        'x-flock-phase5-client-capability'
      ];
      if (typeof capability !== 'string') {
        networkSocket.destroy?.();
        return true;
      }
      try {
        faultClaim = claimRegistry.claim({
          socketKind: 'runtime',
          capability,
        });
      } catch {
        networkSocket.destroy?.();
        return true;
      }
    }
    webSocketServer.handleUpgrade(
      request,
      networkSocket,
      head,
      (socket) => {
        webSocketServer.emit(
          'connection',
          socket,
          request,
          faultClaim,
          claimRegistry,
        );
      },
    );
    return true;
  }

  webSocketServer.on(
    'connection',
    (socket, _request, faultClaim, claimRegistry) => acceptConnection(
      socket,
      faultClaim ?? null,
      claimRegistry ?? null,
    ),
  );

  return Object.freeze({ handleUpgrade, routeCommand });
}
