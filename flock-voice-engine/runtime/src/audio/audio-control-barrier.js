const ALL_OFF = Object.freeze([
  Object.freeze({ type: 'preview.allOff' }),
  Object.freeze({ type: 'voice.allOff' }),
  Object.freeze({ type: 'voice.reset' }),
]);

export function createAudioControlBarrier({
  runExclusive,
  planner,
  workerControl,
  publicStatusStore,
  legacyAccess,
  streamTimeline,
} = {}) {
  if (typeof runExclusive !== 'function' || typeof planner?.pauseWorldWrites !== 'function'
      || typeof planner?.resumeWorldWrites !== 'function'
      || typeof workerControl?.apply !== 'function' || typeof workerControl?.replaceWorld !== 'function'
      || typeof publicStatusStore?.commitInsideMailbox !== 'function'
      || typeof legacyAccess?.rejectWrites !== 'function'
      || typeof legacyAccess?.allowExactGeneration !== 'function'
      || typeof streamTimeline?.discontinuity !== 'function') {
    throw new Error('AUDIO_CONTROL_BARRIER_DEPENDENCIES_REQUIRED');
  }
  let tail = Promise.resolve();
  let transitioning = false;

  function serialize(operation) {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  }

  async function failClosed(reason) {
    await runExclusive('audio-owner-transition-failed', () => {
      transitioning = true;
      planner.pauseWorldWrites(reason);
      legacyAccess.rejectWrites(reason);
      publicStatusStore.commitInsideMailbox({ recovering: true, workerReady: false,
        degraded: true, degradedReason: reason });
    });
  }

  function enterLegacy({ reason = 'legacy-take', decoderSessionId } = {}) {
    return serialize(async () => {
      if (typeof decoderSessionId !== 'string' || decoderSessionId.length === 0) {
        throw new Error('LEGACY_DECODER_SESSION_REQUIRED');
      }
      try {
        await runExclusive('audio-owner-transition-begin', () => {
          transitioning = true;
          planner.pauseWorldWrites(reason);
          legacyAccess.rejectWrites(reason);
          publicStatusStore.commitInsideMailbox({ recovering: true });
        });
        const control = await workerControl.apply(ALL_OFF);
        await runExclusive('audio-owner-transition-legacy', () => {
          control?.validate?.();
          publicStatusStore.commitInsideMailbox({ ...(control?.readyPatch ?? {}),
            audioOwner: 'legacy', recovering: false,
            workerReady: true, degraded: false, degradedReason: null });
          if (typeof control?.commitStream === 'function') control.commitStream();
          else streamTimeline.discontinuity('legacy-take');
          legacyAccess.allowExactGeneration(decoderSessionId);
          control?.commitReady?.();
          transitioning = false;
        });
        return Object.freeze({ ok: true, audioOwner: 'legacy', decoderSessionId });
      } catch (error) {
        await failClosed(error?.message ?? 'AUDIO_OWNER_TRANSITION_FAILED');
        throw error;
      }
    });
  }

  function restoreWorld(reason = 'legacy-release') {
    return serialize(async () => {
      try {
        await runExclusive('audio-owner-transition-begin', () => {
          transitioning = true;
          planner.pauseWorldWrites(reason);
          legacyAccess.rejectWrites(reason);
          publicStatusStore.commitInsideMailbox({ recovering: true });
        });
        await workerControl.apply(ALL_OFF);
        const replacement = await workerControl.replaceWorld();
        await runExclusive('audio-owner-transition-world', () => {
          replacement?.validate?.();
          publicStatusStore.commitInsideMailbox({ ...(replacement?.readyPatch ?? {}),
            audioOwner: 'world', recovering: false,
            workerReady: true, degraded: false, degradedReason: null });
          if (typeof replacement?.commitStream === 'function') replacement.commitStream();
          else streamTimeline.discontinuity('world-restore');
          const resumed = planner.resumeWorldWrites();
          if (resumed?.accepted !== true) throw new Error(resumed?.reason ?? 'WORLD_WRITES_RESUME_FAILED');
          replacement?.commitReady?.();
          transitioning = false;
        });
        return Object.freeze({ ok: true, audioOwner: 'world' });
      } catch (error) {
        await failClosed(error?.message ?? 'AUDIO_OWNER_TRANSITION_FAILED');
        throw error;
      }
    });
  }

  return Object.freeze({ enterLegacy, restoreWorld,
    getStatus: () => Object.freeze({ transitioning }) });
}
