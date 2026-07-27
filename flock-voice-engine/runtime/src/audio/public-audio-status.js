function freeze(value) {
  const cloned = structuredClone(value);
  return Object.freeze(cloned);
}
const PUBLIC_KEYS = new Set(['runtimeOwner', 'audioOwner', 'workerReady', 'recovering',
  'degraded', 'degradedReason', 'audio']);

export function createPublicAudioStatusStore({ session = null, initialStatus = {} } = {}) {
  let revision = 0;
  let current = freeze({ statusRevision: revision, workerReady: false, recovering: true,
    degraded: false, degradedReason: null, runtimeOwner: 'server', audioOwner: 'world',
    audio: null, ...initialStatus });
  const listeners = new Set();
  function validatePatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.keys(patch).some((key) => !PUBLIC_KEYS.has(key))) {
      throw new Error('AUDIO_STATUS_PATCH_INVALID');
    }
  }
  function commitPatch(patch) {
      if (revision >= 0xffff_ffff) throw new Error('AUDIO_STATUS_REVISION_EXHAUSTED');
      revision += 1;
      current = freeze({ ...current, ...structuredClone(patch), statusRevision: revision });
      for (const listener of [...listeners]) {
        try { listener(current); } catch { /* isolated observer */ }
      }
      return current;
  }
  async function update(patch) {
    validatePatch(patch);
    const commit = () => commitPatch(patch);
    if (session?.runExclusive) return session.runExclusive('audio-status', commit);
    return commit();
  }
  async function guardedUpdate(patch, guard, beforePublish, afterPublish = () => {}) {
    validatePatch(patch);
    if (typeof guard !== 'function' || typeof beforePublish !== 'function') {
      throw new Error('AUDIO_STATUS_GUARD_INVALID');
    }
    const commit = () => {
      if (guard() !== true) return Object.freeze({ updated: false, result: null });
      const result = beforePublish();
      if (result?.accepted !== true) return Object.freeze({ updated: false, result });
      const next = commitPatch(patch);
      afterPublish(next);
      return Object.freeze({ updated: true, result, status: next });
    };
    if (session?.runExclusive) return session.runExclusive('audio-status-ready', commit);
    return commit();
  }
  return Object.freeze({
    get: () => current,
    update,
    guardedUpdate,
    commitInsideMailbox(patch) { validatePatch(patch); return commitPatch(patch); },
    subscribe(listener, { replayCurrent = false } = {}) {
      if (typeof listener !== 'function') throw new Error('AUDIO_STATUS_LISTENER_INVALID');
      listeners.add(listener);
      if (replayCurrent) listener(current);
      return () => listeners.delete(listener);
    },
  });
}
