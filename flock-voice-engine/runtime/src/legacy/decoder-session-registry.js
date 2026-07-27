import { randomUUID } from 'node:crypto';

export function createDecoderSessionRegistry({ tokenFactory = randomUUID } = {}) {
  if (typeof tokenFactory !== 'function') throw new Error('DECODER_SESSION_CONFIG_INVALID');
  const sessions = new Map();
  const sockets = new WeakMap();
  let generation = 0;

  function attach(socket, { split = false } = {}) {
    if (!socket || sockets.has(socket)) throw new Error('DECODER_SOCKET_ALREADY_ATTACHED');
    if (generation >= Number.MAX_SAFE_INTEGER) throw new Error('DECODER_SESSION_ID_EXHAUSTED');
    let entropy;
    try { entropy = tokenFactory(); } catch { throw new Error('DECODER_SESSION_ID_UNAVAILABLE'); }
    if (typeof entropy !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entropy)) {
      throw new Error('DECODER_SESSION_ID_UNAVAILABLE');
    }
    generation += 1;
    const decoderSessionId = `decoder-${generation}-${entropy}`;
    const session = Object.freeze({ decoderSessionId, socket, split: split === true });
    sessions.set(decoderSessionId, session); sockets.set(socket, decoderSessionId);
    return session;
  }

  function detach(target) {
    const id = typeof target === 'string' ? target : sockets.get(target);
    const session = sessions.get(id);
    if (!session) return null;
    sessions.delete(id); sockets.delete(session.socket);
    return session;
  }

  return Object.freeze({ attach, detach, get: (id) => sessions.get(id) ?? null,
    isActive: (id) => sessions.has(id), list: () => Object.freeze([...sessions.values()]) });
}
