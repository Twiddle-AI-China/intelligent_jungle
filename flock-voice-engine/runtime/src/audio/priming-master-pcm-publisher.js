export function createPrimingMasterPcmPublisher({ downstream = null } = {}) {
  let resolvePrime = null;
  let prime = Promise.resolve();
  let minStartFrame = 0n;
  let publicFrameOffset = 0n;
  let publicStartFrame = 0n;
  let streamValue = null;
  let downstreamBegun = false;
  let sourceAudioEpoch = null;
  let sourceNextStartFrame = 0n;
  let streamActive = false;
  let primePending = false;
  return Object.freeze({
    hold() {
      streamActive = false;
      downstreamBegun = false;
      streamValue = null;
      primePending = false;
      prime = new Promise((resolve) => { resolvePrime = resolve; });
      downstream?.hold?.();
    },
    beginStream(value) {
      if (typeof value?.minStartFrame !== 'bigint') throw new Error('AUDIO_PRIME_FRAME_REQUIRED');
      if (typeof value.audioEpoch === 'string' && sourceAudioEpoch === value.audioEpoch
          && value.minStartFrame < sourceNextStartFrame) {
        throw new Error('AUDIO_SOURCE_CURSOR_ROLLBACK');
      }
      if (typeof value.audioEpoch === 'string' && sourceAudioEpoch !== value.audioEpoch) {
        sourceAudioEpoch = value.audioEpoch;
        sourceNextStartFrame = value.minStartFrame;
      }
      minStartFrame = value.minStartFrame;
      streamActive = true;
      primePending = true;
      publicStartFrame = minStartFrame;
      const downstreamStatus = downstream?.getStatus?.();
      if (downstreamStatus && typeof downstream?.getLiveCursor === 'function') {
        publicStartFrame = downstreamStatus.audioEpoch === value.audioEpoch
          ? downstream.getLiveCursor().startFrame : 0n;
      }
      streamValue = value;
      downstreamBegun = false;
    },
    publish(block) {
      if (!streamActive || typeof block?.startFrame !== 'bigint' || block.startFrame < minStartFrame) {
        return false;
      }
      if (!downstreamBegun) {
        publicFrameOffset = block.startFrame - publicStartFrame;
        downstream?.beginStream?.({ ...streamValue, minStartFrame: publicStartFrame });
        downstreamBegun = true;
      }
      const publicBlock = publicFrameOffset === 0n ? block
        : { ...block, startFrame: block.startFrame - publicFrameOffset };
      if (downstream?.publish?.(publicBlock) === false) return false;
      if (typeof block.frameCount === 'number' && Number.isSafeInteger(block.frameCount)
          && block.frameCount > 0) sourceNextStartFrame = block.startFrame + BigInt(block.frameCount);
      if (primePending) {
        primePending = false;
        resolvePrime?.();
        resolvePrime = null;
      }
      return true;
    },
    waitForPostAppliedPrime: () => prime,
  });
}
