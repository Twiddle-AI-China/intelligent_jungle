const U64_DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;
const JSON_KIND = 1;
const PCM_MASTER_KIND = 2;
const PCM_SPLIT_KIND = 3;

export async function createUnixWorkerConnection({ socketPath = '/run/flock-audio/audio.sock',
  outboundCapacity = 256 } = {}) {
  const { createConnection } = await import('node:net');
  const socket = createConnection({ path: socketPath });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve); socket.once('error', reject);
  });
  return connectWorkerProtocol(socket, { outboundCapacity });
}

export function encodeU64Decimal(value) {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) throw new Error('U64_OUT_OF_RANGE');
  return value.toString();
}

export function decodeU64Decimal(value) {
  if (typeof value !== 'string' || !U64_DECIMAL.test(value)) throw new Error('U64_DECIMAL_INVALID');
  const decoded = BigInt(value);
  if (decoded > U64_MAX) throw new Error('U64_OUT_OF_RANGE');
  return decoded;
}

function jsonFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 1_048_576) throw new Error('IPC_FRAME_TOO_LARGE');
  const frame = Buffer.allocUnsafe(body.length + 5);
  frame.writeUInt32BE(body.length, 0); frame[4] = JSON_KIND; body.copy(frame, 5);
  return frame;
}

const CONTINUOUS_COMMANDS = new Set(['continuous.set', 'latent.set', 'mix.set']);
function continuousBatch(value) {
  return value?.type === 'audio.command.batch' && Array.isArray(value.commands)
    && value.commands.length > 0 && value.commands.every((command) => CONTINUOUS_COMMANDS.has(command?.type));
}
function continuousKey(command) {
  return JSON.stringify([command.type, command.worldId ?? null, command.voice ?? null,
    command.row ?? null, command.species ?? null, command.param ?? null]);
}
function mergeContinuous(older, newer) {
  const values = new Map(older.commands.map((command) => [continuousKey(command), command]));
  for (const command of newer.commands) values.set(continuousKey(command), command);
  return { ...newer, commands: [...values.values()] };
}

function parsePcm(body) {
  if (body.length < 16) throw new Error('IPC_PCM_HEADER_INVALID');
  const startFrame = body.readBigUInt64LE(0);
  const frameCount = body.readUInt32LE(8);
  const channels = body.readUInt16LE(12);
  const format = body.readUInt16LE(14);
  if (frameCount === 0 || channels === 0 || format !== 1
      || body.length !== 16 + frameCount * channels * 4) {
    throw new Error('IPC_PCM_PAYLOAD_SIZE_MISMATCH');
  }
  return Object.freeze({ startFrame, frameCount, channels, format, payload: Buffer.from(body.subarray(16)) });
}

export function assertExactAudioGeometry(expected, reported) {
  if (!expected || !reported || expected.sampleRate !== reported.sampleRate
      || expected.blockFrames !== reported.blockFrames || expected.poolSize !== reported.poolSize
      || !Array.isArray(expected.rowVoices) || !Array.isArray(reported.rowVoices)
      || expected.rowVoices.length !== reported.rowVoices.length
      || expected.rowVoices.some((voice, index) => voice !== reported.rowVoices[index])) {
    throw new Error('AUDIO_READY_GEOMETRY_MISMATCH');
  }
}

export function connectWorkerProtocol(socket, { outboundCapacity = 256,
  scheduleWriter = (operation) => setImmediate(operation) } = {}) {
  if (!socket?.on || typeof socket.write !== 'function') throw new Error('WORKER_SOCKET_REQUIRED');
  let buffer = Buffer.alloc(0);
  let closed = false;
  let writing = false;
  let writerScheduled = false;
  const outbound = [];
  const messages = [];
  const waiters = [];
  const listeners = new Set();

  function publish(item) {
    const index = waiters.findIndex((waiter) => waiter.predicate(item));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(item);
    for (const listener of listeners) listener(item);
    if (index < 0 && listeners.size === 0) messages.push(item);
  }
  function fail(error) {
    if (closed) return;
    closed = true;
    while (waiters.length) waiters.shift().reject(error);
    for (const listener of listeners) {
      try { listener({ type: 'worker.connection.closed', error }); } catch { /* isolated */ }
    }
  }
  function parse() {
    while (buffer.length >= 5) {
      const length = buffer.readUInt32BE(0); const kind = buffer[4];
      const limit = kind === JSON_KIND ? 1_048_576 : 4_194_304;
      if (![JSON_KIND, PCM_MASTER_KIND, PCM_SPLIT_KIND].includes(kind) || length > limit) {
        fail(new Error('IPC_FRAME_INVALID')); socket.destroy?.(); return;
      }
      if (buffer.length < length + 5) return;
      const body = buffer.subarray(5, 5 + length); buffer = buffer.subarray(5 + length);
      try {
        publish(kind === JSON_KIND ? JSON.parse(body.toString('utf8'))
          : { type: kind === PCM_MASTER_KIND ? 'pcm.master' : 'pcm.split', ...parsePcm(body) });
      } catch (error) { fail(error); socket.destroy?.(); return; }
    }
  }
  socket.on('data', (data) => { buffer = Buffer.concat([buffer, data]); parse(); });
  socket.on('error', fail); socket.on('close', () => fail(new Error('WORKER_CONNECTION_CLOSED')));

  function next(predicate = () => true, timeoutMs = 5000) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = { predicate, resolve(value) { clearTimeout(timer); resolve(value); }, reject };
      const timer = setTimeout(() => { const at = waiters.indexOf(entry); if (at >= 0) waiters.splice(at, 1); reject(new Error('WORKER_PROTOCOL_TIMEOUT')); }, timeoutMs);
      waiters.push(entry);
    });
  }
  function drain() {
    writerScheduled = false;
    if (writing || outbound.length === 0 || closed) return;
    writing = true;
    const entry = outbound[0];
    try {
      socket.write(entry.frame, (error) => {
        writing = false;
        if (error) { fail(error); return; }
        outbound.shift(); scheduleDrain();
      });
    } catch (error) {
      writing = false;
      fail(error);
      socket.destroy?.();
    }
  }
  function scheduleDrain() {
    if (writerScheduled || writing || outbound.length === 0 || closed) return;
    writerScheduled = true;
    scheduleWriter(drain);
  }
  function enqueue(value) {
    if (!closed && continuousBatch(value)) {
      const tailIndex = outbound.length - 1;
      const tail = outbound[tailIndex];
      // Never mutate the in-flight head; queued continuous state may collapse to its latest values.
      if (tail && tailIndex >= (writing ? 1 : 0) && continuousBatch(tail.value)) {
        const merged = mergeContinuous(tail.value, value);
        outbound[tailIndex] = { value: merged, frame: jsonFrame(merged) };
        return { accepted: true, reason: null, coalesced: true };
      }
    }
    // The in-flight frame remains at outbound[0] until its write callback fires.
    if (closed || outbound.length >= outboundCapacity) {
      return { accepted: false, reason: 'RUNTIME_AUDIO_OUTBOUND_OVERFLOW' };
    }
    outbound.push({ value, frame: jsonFrame(value) }); scheduleDrain();
    return { accepted: true, reason: null };
  }
  return Object.freeze({
    readWorkerHello: () => next((x) => x?.type === 'worker.hello'),
    acceptIdentity(identity) { const result = enqueue({ type: 'runtime.identity.accepted', identity });
      if (!result.accepted) throw new Error(result.reason); },
    readWorkerReady: async () => { const value = await next((x) => x?.type === 'worker.ready');
      return Object.freeze({ ...value, renderFrame: decodeU64Decimal(value.renderFrame) }); },
    enqueueBatch: enqueue,
    async replaceAndWait(state, timeoutMs = 5000) {
      const result = enqueue(state); if (!result.accepted) throw new Error(result.reason);
      const value = await next((x) => x?.type === 'audio.state.applied'
        && x.audioEpoch === state.audioEpoch && x.appliedCommandSeq === state.commandSeq, timeoutMs);
      return Object.freeze({ ...value, renderFrame: decodeU64Decimal(value.renderFrame) });
    },
    next, subscribe(listener) {
      listeners.add(listener);
      for (let index = 0; index < messages.length;) {
        if (['pcm.master', 'pcm.split', 'command.accepted', 'command.rejected',
          'audio.telemetry'].includes(messages[index]?.type)) {
          listener(messages.splice(index, 1)[0]);
        } else index += 1;
      }
      return () => listeners.delete(listener);
    },
    get outboundQueueDepth() { return outbound.length; },
    close() { if (!closed) { closed = true; socket.destroy?.(); } },
  });
}
