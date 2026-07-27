import { blocksForWindow } from './pcm-ring.js';

export function createSplitRing({ geometry, historyMs = 3000 } = {}) {
  const sampleRate = geometry?.sampleRate;
  const blockFrames = geometry?.blockFrames;
  const channels = geometry?.poolSize;
  if (!Number.isSafeInteger(channels) || channels <= 0) throw new Error('SPLIT_GEOMETRY_INVALID');
  const capacity = blocksForWindow(historyMs, sampleRate, blockFrames);
  const records = [];
  const listeners = new Set();
  let nextStartFrame = null;

  function publish(block) {
    if (!block || block.frameCount !== blockFrames || block.channels !== channels || block.format !== 1
        || typeof block.startFrame !== 'bigint'
        || !Buffer.isBuffer(block.payload)
        || block.payload.length !== blockFrames * channels * 4) {
      throw new Error('SPLIT_BLOCK_INVALID');
    }
    if (nextStartFrame !== null && block.startFrame !== nextStartFrame) {
      throw new Error('SPLIT_CURSOR_DISCONTINUITY');
    }
    const record = Object.freeze({ startFrame: block.startFrame, frameCount: blockFrames,
      channels, format: 1, payload: Buffer.from(block.payload) });
    records.push(record);
    while (records.length > capacity) records.shift();
    nextStartFrame = block.startFrame + BigInt(blockFrames);
    for (const listener of [...listeners]) listener(record);
    return true;
  }

  return Object.freeze({
    publish,
    reset() { records.length = 0; nextStartFrame = null; },
    attach(listener) {
      if (typeof listener !== 'function') throw new Error('SPLIT_LISTENER_INVALID');
      listeners.add(listener);
      return Object.freeze({ history: Object.freeze([...records]),
        unsubscribe: () => listeners.delete(listener) });
    },
    snapshot: () => Object.freeze([...records]),
    getStatus: () => Object.freeze({ sampleRate, blockFrames, channels, capacity,
      size: records.length, nextStartFrame }),
  });
}
