export function createPrimingMasterPcmPublisher({ downstream = null } = {}) {
  let resolvePrime = null;
  let prime = Promise.resolve();
  let minStartFrame = 0n;
  let streamActive = false;
  let primePending = false;
  return Object.freeze({
    hold() {
      streamActive = false;
      primePending = false;
      prime = new Promise((resolve) => { resolvePrime = resolve; });
      downstream?.hold?.();
    },
    beginStream(value) {
      if (typeof value?.minStartFrame !== 'bigint') throw new Error('AUDIO_PRIME_FRAME_REQUIRED');
      minStartFrame = value.minStartFrame;
      streamActive = true;
      primePending = true;
      downstream?.beginStream?.(value);
    },
    publish(block) {
      if (!streamActive || typeof block?.startFrame !== 'bigint' || block.startFrame < minStartFrame) {
        return false;
      }
      if (primePending) {
        primePending = false;
        resolvePrime?.();
        resolvePrime = null;
      }
      downstream?.publish?.(block);
      return true;
    },
    waitForPostAppliedPrime: () => prime,
  });
}
