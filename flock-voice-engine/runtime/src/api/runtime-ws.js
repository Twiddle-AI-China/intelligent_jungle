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
}) {
  if (typeof getSession !== 'function' || typeof originPolicy?.authorize !== 'function') {
    throw new Error('RUNTIME_WS_DEPENDENCIES_REQUIRED');
  }

  async function routeCommand({
    session,
    clientId,
    generation,
    command,
    egress,
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
      return session.requestSnapshot({ clientId, generation, command });
    }
    return session.executeCommand({
      clientId,
      generation,
      command,
    });
  }

  function acceptConnection(socket) {
    let phase = 'awaiting-hello';
    let context = null;
    let cleanupPromise = null;
    let unsubscribeAudioStatus = null;

    function ensureCleanup() {
      if (cleanupPromise) return cleanupPromise;
      unsubscribeAudioStatus?.(); unsubscribeAudioStatus = null;
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
    socket.on('close', async () => {
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

          const clientId = frame.clientId;
          const generation = nextSocketGeneration();
          const session = getSession('default');
          const egress = createEgress({
            socket,
            capacity: egressCapacity,
          });
          context = {
            clientId,
            generation,
            session,
            egress,
          };

          try {
            await session.attach({
              clientId,
              token: frame.bootstrapToken ?? frame.resumeToken,
              worldGeneration: frame.worldGeneration,
              lastRevision: frame.lastRevision,
              lastEventSeq: frame.lastEventSeq,
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
    webSocketServer.handleUpgrade(
      request,
      networkSocket,
      head,
      (socket) => {
        webSocketServer.emit('connection', socket, request);
      },
    );
    return true;
  }

  webSocketServer.on('connection', acceptConnection);

  return Object.freeze({ handleUpgrade, routeCommand });
}
