import { blocksForWindow } from './pcm-ring.js';

function json(value) { return JSON.stringify(value); }

export function createAudioClientWriter({ socket, ring, getAudioReady, egressMs = 500 } = {}) {
  const ringStatus = ring?.getStatus?.();
  if (!socket || typeof socket.send !== 'function' || !ringStatus || typeof getAudioReady !== 'function') {
    throw new Error('AUDIO_CLIENT_WRITER_DEPENDENCIES_REQUIRED');
  }
  const capacity = blocksForWindow(egressMs, ringStatus.sampleRate, ringStatus.blockFrames);
  let pending = [];
  let writing = false;
  let inFlightBinary = false;
  let stopped = false;
  let unsubscribe = null;

  function send(entry, done) {
    const options = entry.binary ? { binary: true } : { binary: false };
    try { socket.send(entry.data, options, done); } catch (error) { done(error); }
  }
  function failConnection() {
    stop();
    try { socket.close?.(1011, 'AUDIO_SEND_FAILED'); } catch { socket.terminate?.(); }
  }
  function drain() {
    if (stopped || writing || pending.length === 0) return;
    writing = true;
    const entry = pending.shift();
    inFlightBinary = entry.binary;
    send(entry, (error) => {
      writing = false; inFlightBinary = false;
      if (error) { failConnection(); return; }
      drain();
    });
  }
  function readyFrame(cursor) {
    const audio = getAudioReady();
    const status = ring.getStatus();
    if (!audio || status.audioEpoch === null) throw new Error('AUDIO_STREAM_NOT_READY');
    return { type: 'audio.ready', protocolVersion: 1, audioEpoch: status.audioEpoch,
      streamRevision: cursor.streamRevision, blockSeq: cursor.blockSeq,
      resumeStartFrame: cursor.startFrame.toString(), ...audio };
  }
  function clientSkip() {
    const snapshot = ring.snapshot();
    const tail = snapshot.slice(-capacity);
    const first = tail[0];
    const cursor = first ? { streamRevision: first.streamRevision, blockSeq: first.blockSeq,
      startFrame: first.startFrame } : ring.getLiveCursor();
    pending = [{ binary: false, data: json({ type: 'audio.discontinuity', protocolVersion: 1,
      scope: 'client', audioEpoch: ring.getStatus().audioEpoch,
      streamRevision: cursor.streamRevision, blockSeq: cursor.blockSeq,
      resumeStartFrame: cursor.startFrame.toString() }) },
    ...tail.map((record) => ({ binary: true, data: record.frame }))];
  }
  function onRing(value) {
    if (value.type === 'audio.discontinuity') {
      pending = [{ binary: false, data: json({ ...value, protocolVersion: 1 }) }];
      return drain();
    }
    if (value.type !== 'pcm.block') return;
    const queuedBinary = pending.filter((entry) => entry.binary).length + (inFlightBinary ? 1 : 0);
    if (queuedBinary >= capacity) clientSkip();
    else pending.push({ binary: true, data: value.record.frame });
    drain();
  }
  function start() {
    const attached = ring.attach(onRing);
    unsubscribe = attached.unsubscribe;
    try {
      const history = attached.history.slice(-capacity);
      const first = history[0];
      const cursor = first ? { streamRevision: first.streamRevision, blockSeq: first.blockSeq,
        startFrame: first.startFrame } : ring.getLiveCursor();
      pending.push({ binary: false, data: json(readyFrame(cursor)) },
        ...history.map((record) => ({ binary: true, data: record.frame })));
      drain();
      return true;
    } catch (error) {
      unsubscribe?.(); unsubscribe = null;
      throw error;
    }
  }
  function stop() {
    if (stopped) return false;
    stopped = true; pending = []; unsubscribe?.(); unsubscribe = null;
    return true;
  }
  return Object.freeze({ start, stop, getStatus: () => Object.freeze({ capacity,
    queued: pending.length, writing, stopped }) });
}
