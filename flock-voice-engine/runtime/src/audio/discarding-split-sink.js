export function createDiscardingSplitSink({ telemetry = null } = {}) {
  let drainedBlocks = 0;
  return Object.freeze({
    publish(block) {
      drainedBlocks += 1;
      telemetry?.({ type: 'audio.split.discarded', startFrame: block?.startFrame });
      return true;
    },
    get drainedBlocks() { return drainedBlocks; },
  });
}
