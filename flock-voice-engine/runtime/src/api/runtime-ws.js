import { WebSocketServer } from 'ws';

import { createConnectionEgress } from './connection-egress.js';
import { PROTOCOL_VERSION } from '../protocol/v1.js';
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
  allowedOrigin,
  egressCapacity = 256,
  createEgress = createConnectionEgress,
  webSocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
  }),
  audioStatusStore = null,
}) {
  if (typeof getSession !== 'function' || typeof allowedOrigin !== 'string') {
    throw new Error('RUNTIME_WS_DEPENDENCIES_REQUIRED');
  }

  async function routeCommand({
    session,
    clientId,
    generation,
    command,
  }) {
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
    webSocketServer.handleUpgrade(
      request,
      networkSocket,
      head,
      (socket) => {
        if (request.headers.origin !== allowedOrigin) {
          socket.close(4403, 'ORIGIN_FORBIDDEN');
          return;
        }
        const pathname = new URL(
          request.url ?? '/',
          'http://127.0.0.1',
        ).pathname;
        if (pathname !== '/api/v1/runtime') {
          socket.close(4404, 'RUNTIME_PATH_REQUIRED');
          return;
        }
        webSocketServer.emit('connection', socket, request);
      },
    );
  }

  webSocketServer.on('connection', acceptConnection);

  return Object.freeze({ handleUpgrade, routeCommand });
}
