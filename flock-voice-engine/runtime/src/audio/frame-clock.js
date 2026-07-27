const U64_MAX = (1n << 64n) - 1n;

export function createFrameClock({ sampleRate, blockFrames, leadBlocks = 2 }) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0
      || !Number.isInteger(blockFrames) || blockFrames <= 0
      || !Number.isInteger(leadBlocks) || leadBlocks < 0) {
    throw new Error('AUDIO_GEOMETRY_REQUIRED');
  }
  let map = null;
  return Object.freeze({
    replace(next) {
      if (!next || typeof next.worldTimeSeconds !== 'number' || !Number.isFinite(next.worldTimeSeconds)
          || typeof next.renderFrame !== 'bigint' || next.renderFrame < 0n || next.renderFrame > U64_MAX) {
        throw new Error('AUDIO_FRAME_MAP_INVALID');
      }
      map = Object.freeze({ ...next });
    },
    targetFrame(worldTimeSeconds) {
      if (!map) throw new Error('AUDIO_FRAME_MAP_MISSING');
      if (!Number.isFinite(worldTimeSeconds)) throw new Error('AUDIO_WORLD_TIME_INVALID');
      const delta = Math.max(0, worldTimeSeconds - map.worldTimeSeconds);
      const projected = map.renderFrame + BigInt(Math.round(delta * sampleRate));
      const lead = map.renderFrame + BigInt(blockFrames * leadBlocks);
      const result = projected > lead ? projected : lead;
      if (result > U64_MAX) throw new Error('AUDIO_FRAME_EXHAUSTED');
      return result;
    },
    addSeconds(frame, seconds) {
      if (typeof frame !== 'bigint' || frame < 0n || !Number.isFinite(seconds) || seconds < 0) {
        throw new Error('AUDIO_FRAME_OFFSET_INVALID');
      }
      const result = frame + BigInt(Math.round(seconds * sampleRate));
      if (result > U64_MAX) throw new Error('AUDIO_FRAME_EXHAUSTED');
      return result;
    },
    get() { return map; },
  });
}
