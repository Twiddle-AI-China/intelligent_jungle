import { parseAudioFrameV1 } from './pcm-protocol.js';

const U64_DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 0xffff_ffff;
const HISTORY_MS = 3000;
const GEOMETRY_KEYS = ['audioEpoch', 'manifestGeometrySha256', 'sampleRate', 'blockFrames',
  'channels', 'format', 'binaryHeaderVersion', 'headerBytes'];

function playerError(code) { const error = new Error(code); error.code = code; return error; }
function decodeU64(value) {
  if (typeof value !== 'string' || !U64_DECIMAL.test(value)) throw playerError('AUDIO_CURSOR_INVALID');
  const result = BigInt(value); if (result > U64_MAX) throw playerError('AUDIO_CURSOR_INVALID');
  return result;
}
function exactGeometry(expected, actual) {
  return expected && actual && GEOMETRY_KEYS.every((key) => expected[key] === actual[key]);
}
function validU32(value) {
  return Number.isInteger(value) && !Object.is(value, -0) && value >= 0 && value <= U32_MAX;
}

export function createPcmPlayer({ runtimeClient, audioContextFactory, webSocketFactory,
  workletNodeFactory = (context) => new AudioWorkletNode(context, 'flock-pcm-player') } = {}) {
  if (typeof runtimeClient?.subscribeStatus !== 'function' || typeof audioContextFactory !== 'function'
      || typeof webSocketFactory !== 'function' || typeof workletNodeFactory !== 'function') {
    throw playerError('PCM_PLAYER_DEPENDENCIES_REQUIRED');
  }
  let expectedAudio = null;
  let socket = null;
  let socketGeneration = 0;
  let context = null;
  let node = null;
  let expectedCursor = null;
  let enabled = false;
  let state = 'disabled';
  let bufferedFrames = 0;
  let lastError = null;
  let pendingBinary = [];
  let runtimeReady = false;
  let started = false;
  let stoppedByUser = false;

  function status() {
    return Object.freeze({ state, enabled, bufferedFrames,
      blockFrames: expectedAudio?.blockFrames ?? null,
      primeFrames: expectedAudio ? expectedAudio.blockFrames * 3 : 0,
      lastError });
  }
  function clearWorklet(reason) {
    bufferedFrames = 0;
    try { node?.port?.postMessage({ type: 'reset', reason }); } catch { /* already detached */ }
  }
  function closeSocket(reason) {
    socketGeneration += 1;
    const active = socket; socket = null;
    try { active?.close?.(1000, reason); } catch { /* local generation is authoritative */ }
  }
  function disableAndClear(reason) {
    enabled = false; state = 'disabled'; lastError = reason; expectedCursor = null;
    pendingBinary = [];
    closeSocket(reason); clearWorklet(reason);
    try { node?.disconnect?.(); } catch { /* best effort */ }
    node = null;
    try { context?.close?.(); } catch { /* best effort */ }
    context = null;
  }
  function reconnectAudio(reason) {
    enabled = false; state = 'reconnecting'; lastError = reason; expectedCursor = null;
    pendingBinary = []; clearWorklet(reason);
    try { node?.disconnect?.(); } catch { /* best effort */ }
    node = null;
    try { context?.close?.(); } catch { /* best effort */ }
    context = null;
    closeSocket(reason);
    const audio = expectedAudio;
    queueMicrotask(() => {
      if (runtimeReady && !stoppedByUser && socket === null && expectedAudio === audio) enable(audio);
    });
  }
  async function createOutput(generation) {
    if (context !== null) return true;
    const created = await audioContextFactory({ sampleRate: expectedAudio.sampleRate });
    if (generation !== socketGeneration) { await created.close?.(); return false; }
    context = created;
    await created.audioWorklet.addModule(new URL('./pcm-player-worklet.js', import.meta.url));
    if (generation !== socketGeneration) { await created.close?.(); return false; }
    const createdNode = workletNodeFactory(created);
    createdNode.connect(created.destination);
    node = createdNode;
    node.port.onmessage = ({ data }) => {
      if (generation === socketGeneration && data?.type === 'overflow') {
        reconnectAudio('AUDIO_PLAYBACK_OVERFLOW');
      }
    };
    clearWorklet('AUDIO_PRIME');
    node.port.postMessage({ type: 'configure', primeFrames: expectedAudio.blockFrames * 3,
      maxBufferedFrames: Math.ceil((HISTORY_MS * expectedAudio.sampleRate) / 1000) });
    if (started) {
      try { await created.resume?.(); } catch { /* keep the latched user intent */ }
    }
    return true;
  }
  function acceptReady(ready) {
    const readyKeys = ['type', 'protocolVersion', 'streamRevision', 'blockSeq',
      'resumeStartFrame', ...GEOMETRY_KEYS].sort().join(',');
    if (state !== 'connecting' || expectedCursor !== null
        || !ready || ready.type !== 'audio.ready' || ready.protocolVersion !== 1
        || Object.keys(ready).sort().join(',') !== readyKeys
        || !exactGeometry(expectedAudio, ready)) {
      disableAndClear('AUDIO_READY_GEOMETRY_MISMATCH');
      throw playerError('AUDIO_READY_GEOMETRY_MISMATCH');
    }
    if (!validU32(ready.streamRevision) || !validU32(ready.blockSeq)) {
      disableAndClear('AUDIO_READY_CURSOR_INVALID');
      throw playerError('AUDIO_READY_CURSOR_INVALID');
    }
    let startFrame;
    try { startFrame = decodeU64(ready.resumeStartFrame); }
    catch {
      disableAndClear('AUDIO_READY_CURSOR_INVALID');
      throw playerError('AUDIO_READY_CURSOR_INVALID');
    }
    expectedCursor = Object.freeze({ streamRevision: ready.streamRevision,
      blockSeq: ready.blockSeq, startFrame });
    state = 'priming';
    const generation = socketGeneration;
    return createOutput(generation).then((created) => {
      if (!created || generation !== socketGeneration) return false;
      enabled = true; lastError = null;
      const queued = pendingBinary; pendingBinary = [];
      for (const data of queued) acceptBinary(data);
      return true;
    });
  }
  function acceptDiscontinuity(frame) {
    const prior = expectedCursor;
    const discontinuityKeys = ['type', 'protocolVersion', 'scope', 'audioEpoch',
      'streamRevision', 'blockSeq', 'resumeStartFrame'].sort().join(',');
    if (!prior || !frame || frame.type !== 'audio.discontinuity' || frame.protocolVersion !== 1
        || Object.keys(frame).sort().join(',') !== discontinuityKeys
        || !['client', 'stream'].includes(frame.scope)
        || frame.audioEpoch !== expectedAudio?.audioEpoch
        || !validU32(frame.streamRevision) || !validU32(frame.blockSeq)) {
      throw playerError('AUDIO_DISCONTINUITY_INVALID');
    }
    const startFrame = decodeU64(frame.resumeStartFrame);
    const ordered = frame.scope === 'client'
      ? frame.streamRevision === prior.streamRevision && frame.blockSeq >= prior.blockSeq
        && startFrame >= prior.startFrame
      : frame.streamRevision > prior.streamRevision;
    if (!ordered) throw playerError('AUDIO_DISCONTINUITY_REORDERED');
    expectedCursor = Object.freeze({ streamRevision: frame.streamRevision,
      blockSeq: frame.blockSeq, startFrame });
    pendingBinary = [];
    clearWorklet('AUDIO_DISCONTINUITY'); state = 'priming';
  }
  function acceptBinary(data) {
    if (!expectedCursor || !node) throw playerError('AUDIO_READY_REQUIRED');
    const parsed = parseAudioFrameV1(data, expectedCursor);
    if (parsed.header.frameCount !== expectedAudio.blockFrames
        || parsed.header.blockSeq >= 0xffff_ffff) throw playerError('AUDIO_BLOCK_GEOMETRY_MISMATCH');
    expectedCursor = Object.freeze({ streamRevision: parsed.header.streamRevision,
      blockSeq: parsed.header.blockSeq + 1,
      startFrame: parsed.header.startFrame + BigInt(parsed.header.frameCount) });
    bufferedFrames += parsed.header.frameCount;
    node.port.postMessage({ type: 'pcm', samples: parsed.samples }, [parsed.samples.buffer]);
    if (bufferedFrames >= expectedAudio.blockFrames * 3) state = 'playing';
  }
  function queuePendingBinary(data) {
    const expectedBytes = 32 + (expectedAudio.blockFrames * 2 * 4);
    const capacity = Math.ceil((HISTORY_MS * expectedAudio.sampleRate)
      / (1000 * expectedAudio.blockFrames));
    if (!(data instanceof ArrayBuffer) || data.byteLength !== expectedBytes) {
      throw playerError('AUDIO_BLOCK_GEOMETRY_MISMATCH');
    }
    if (pendingBinary.length >= capacity) throw playerError('AUDIO_PRIME_OVERFLOW');
    pendingBinary.push(data);
  }
  function handleMessage(event, generation) {
    if (generation !== socketGeneration) return;
    try {
      if (typeof event.data === 'string') {
        const frame = JSON.parse(event.data);
        if (frame.type === 'audio.ready') acceptReady(frame).catch((error) => disableAndClear(error.code));
        else acceptDiscontinuity(frame);
      } else if (node === null && expectedCursor !== null) queuePendingBinary(event.data);
      else acceptBinary(event.data);
    } catch (error) {
      const reason = error?.code ?? 'AUDIO_PROTOCOL_ERROR';
      if (reason === 'AUDIO_PRIME_OVERFLOW') reconnectAudio(reason);
      else disableAndClear(reason);
    }
  }
  function enable(audio) {
    if (exactGeometry(expectedAudio, audio) && socket !== null) return;
    disableAndClear('AUDIO_RECONNECT');
    expectedAudio = Object.freeze(structuredClone(audio));
    state = 'connecting'; lastError = null;
    const generation = socketGeneration + 1; socketGeneration = generation;
    const created = webSocketFactory('/api/v1/audio'); socket = created;
    try { created.binaryType = 'arraybuffer'; } catch { /* optional fake */ }
    created.addEventListener('message', (event) => handleMessage(event, generation));
    created.addEventListener('close', () => {
      if (generation !== socketGeneration) return;
      socket = null; enabled = false; state = 'reconnecting'; expectedCursor = null;
      pendingBinary = []; clearWorklet('AUDIO_SOCKET_CLOSED');
      try { node?.disconnect?.(); } catch { /* best effort */ }
      node = null; try { context?.close?.(); } catch { /* best effort */ } context = null;
      const audio = expectedAudio;
      queueMicrotask(() => {
        if (runtimeReady && !stoppedByUser && socket === null && expectedAudio === audio) enable(audio);
      });
    });
    created.addEventListener('error', () => undefined);
  }
  const unsubscribe = runtimeClient.subscribeStatus((runtimeStatus) => {
    const shouldEnable = runtimeStatus.runtimeOwner === 'server'
      && runtimeStatus.audioOwner === 'world' && runtimeStatus.workerReady === true
      && runtimeStatus.recovering !== true && runtimeStatus.degraded !== true
      && runtimeStatus.audio !== null;
    runtimeReady = shouldEnable;
    if (shouldEnable && !stoppedByUser) enable(runtimeStatus.audio);
    else disableAndClear('PCM_RUNTIME_NOT_READY');
  });

  return Object.freeze({
    start: async () => {
      started = true; stoppedByUser = false;
      if (runtimeReady && socket === null && expectedAudio !== null) enable(expectedAudio);
      if (enabled && context !== null && typeof context.resume === 'function') await context.resume();
      return true;
    },
    stop: () => { started = false; stoppedByUser = true; return disableAndClear('PCM_STOPPED'); },
    reset: () => clearWorklet('PCM_RESET'),
    acceptReady,
    getStatus: status,
    destroy() { started = false; stoppedByUser = true; runtimeReady = false;
      unsubscribe(); disableAndClear('PCM_DESTROYED'); },
  });
}
