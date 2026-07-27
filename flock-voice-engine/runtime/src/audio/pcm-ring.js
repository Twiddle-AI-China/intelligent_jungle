import { encodeAudioFrameV1 } from './pcm-v1.js';

const U32_MAX = 0xffff_ffff;

export function blocksForWindow(ms, sampleRate, blockFrames) {
  if (!Number.isFinite(ms) || ms <= 0 || !Number.isInteger(sampleRate) || sampleRate <= 0
      || !Number.isInteger(blockFrames) || blockFrames <= 0) throw new Error('PCM_WINDOW_INVALID');
  return Math.ceil((ms * sampleRate) / (1000 * blockFrames));
}

export function createPcmRing({ sampleRate, blockFrames, historyMs = 3000 } = {}) {
  const capacity = blocksForWindow(historyMs, sampleRate, blockFrames);
  const records = [];
  const listeners = new Set();
  let audioEpoch = null;
  let streamRevision = 0;
  let blockSeq = 0;
  let nextStartFrame = 0n;
  let active = false;

  function cursor(record = null) {
    return Object.freeze(record ? { streamRevision: record.streamRevision,
      blockSeq: record.blockSeq, startFrame: record.startFrame }
      : { streamRevision, blockSeq, startFrame: nextStartFrame });
  }
  function notify(value) {
    for (const listener of [...listeners]) {
      try { listener(value); } catch { /* isolate client writers */ }
    }
  }
  function discontinuity(scope = 'stream') {
    const value = Object.freeze({ type: 'audio.discontinuity', scope, audioEpoch,
      streamRevision, blockSeq, resumeStartFrame: nextStartFrame.toString() });
    notify(value);
    return value;
  }
  function advanceRevision(epoch, startFrame) {
    if (streamRevision >= U32_MAX) throw new Error('AUDIO_STREAM_REVISION_EXHAUSTED');
    audioEpoch = epoch;
    streamRevision += 1;
    blockSeq = 0;
    nextStartFrame = startFrame;
    records.length = 0;
    active = true;
    discontinuity();
  }

  function validateStream(epoch, minStartFrame) {
    if (typeof epoch !== 'string' || epoch.length === 0 || typeof minStartFrame !== 'bigint'
        || minStartFrame < 0n) throw new Error('PCM_STREAM_IDENTITY_INVALID');
    if ((audioEpoch === null || epoch !== audioEpoch) && minStartFrame !== 0n) {
      throw new Error('PCM_EPOCH_MUST_START_AT_ZERO');
    }
    if (epoch === audioEpoch && minStartFrame < nextStartFrame) throw new Error('PCM_CURSOR_ROLLBACK');
    if (streamRevision >= U32_MAX) throw new Error('AUDIO_STREAM_REVISION_EXHAUSTED');
  }

  function encodeRecord(block, revision, sequence) {
    if (!block || block.frameCount !== blockFrames || block.channels !== 2 || block.format !== 1
        || typeof block.startFrame !== 'bigint') throw new Error('PCM_BLOCK_GEOMETRY_INVALID');
    const header = Object.freeze({ streamRevision: revision, blockSeq: sequence,
      startFrame: block.startFrame, frameCount: blockFrames, channels: 2, format: 1 });
    return Object.freeze({ ...header, frame: encodeAudioFrameV1(header, block.payload) });
  }

  return Object.freeze({
    beginStream({ audioEpoch: epoch, minStartFrame } = {}) {
      validateStream(epoch, minStartFrame);
      advanceRevision(epoch, minStartFrame);
    },
    commitStream({ audioEpoch: epoch, minStartFrame } = {}, blocks = []) {
      validateStream(epoch, minStartFrame);
      if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('PCM_STREAM_BLOCKS_REQUIRED');
      const revision = streamRevision + 1;
      let expected = minStartFrame;
      const prepared = blocks.map((block, sequence) => {
        if (block?.startFrame !== expected) throw new Error('PCM_CURSOR_DISCONTINUITY');
        const record = encodeRecord(block, revision, sequence);
        expected += BigInt(blockFrames);
        return record;
      });
      audioEpoch = epoch; streamRevision = revision; blockSeq = prepared.length;
      nextStartFrame = expected; active = true;
      records.length = 0; records.push(...prepared.slice(-capacity));
      notify(Object.freeze({ type: 'audio.discontinuity', scope: 'stream', audioEpoch,
        streamRevision, blockSeq: 0, resumeStartFrame: minStartFrame.toString() }));
      for (const record of prepared) notify(Object.freeze({ type: 'pcm.block', record }));
      return true;
    },
    hold() { active = false; },
    discontinuity() {
      if (audioEpoch === null) return null;
      advanceRevision(audioEpoch, nextStartFrame);
      return cursor();
    },
    publish(block) {
      if (!active) return false;
      let record = encodeRecord(block, streamRevision, blockSeq);
      if (block.startFrame !== nextStartFrame) throw new Error('PCM_CURSOR_DISCONTINUITY');
      if (blockSeq >= U32_MAX) {
        advanceRevision(audioEpoch, block.startFrame);
        record = encodeRecord(block, streamRevision, blockSeq);
      }
      records.push(record);
      while (records.length > capacity) records.shift();
      blockSeq += 1;
      nextStartFrame = block.startFrame + BigInt(blockFrames);
      notify(Object.freeze({ type: 'pcm.block', record }));
      return true;
    },
    subscribe(listener, { replay = false } = {}) {
      if (typeof listener !== 'function') throw new Error('PCM_RING_LISTENER_INVALID');
      listeners.add(listener);
      if (replay) for (const record of records) listener(Object.freeze({ type: 'pcm.block', record }));
      return () => listeners.delete(listener);
    },
    attach(listener) {
      if (typeof listener !== 'function') throw new Error('PCM_RING_LISTENER_INVALID');
      listeners.add(listener);
      const history = Object.freeze([...records]);
      return Object.freeze({ history, cursor: cursor(history[0] ?? null),
        unsubscribe: () => listeners.delete(listener) });
    },
    snapshot: () => Object.freeze([...records]),
    getCursor: () => cursor(records[0] ?? null),
    getLiveCursor: () => cursor(),
    getStatus: () => Object.freeze({ sampleRate, blockFrames, capacity, size: records.length,
      audioEpoch, streamRevision, blockSeq, nextStartFrame, active }),
  });
}
