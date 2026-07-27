const RESOURCE = 'legacy-audio';
const TTL_MS = 5000;

export function createAudioOwnerController({
  leaseManager,
  maintenanceAuth,
  sessionRegistry,
  controlBarrier,
  legacyAccess,
  maintenanceClientId = 'maintenance',
  clock,
} = {}) {
  if (typeof leaseManager?.take !== 'function' || typeof maintenanceAuth?.verify !== 'function'
      || typeof sessionRegistry?.isActive !== 'function'
      || typeof controlBarrier?.enterLegacy !== 'function'
      || typeof legacyAccess?.isAllowed !== 'function'
      || typeof clock?.now !== 'function') throw new Error('AUDIO_OWNER_DEPENDENCIES_REQUIRED');
  let active = null;
  let tail = Promise.resolve();

  function serialize(operation) {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  }

  function leaseRequest(request) {
    return { resource: RESOURCE, clientId: maintenanceClientId,
      connectionGeneration: request.decoderSessionId, ttlMs: TTL_MS };
  }
  function authorized(request) {
    return maintenanceAuth.verify({ maintenanceToken: request.maintenanceToken,
      clientId: request.clientId ?? maintenanceClientId,
      connectionGeneration: request.connectionGeneration,
      resource: RESOURCE });
  }

  async function takeLegacyNow(request) {
    if (!authorized(request)) throw new Error('MAINTENANCE_AUTH_REQUIRED');
    if (!sessionRegistry.isActive(request.decoderSessionId)) throw new Error('LEGACY_DECODER_SESSION_GONE');
    const acquired = leaseManager.take(leaseRequest(request));
    if (!acquired.ok) return acquired;
    const lease = leaseManager.get(RESOURCE);
    if (acquired.code === 'already_held') {
      active = lease;
      return Object.freeze({ ...acquired, decoderSessionId: request.decoderSessionId });
    }
    active = lease;
    try {
      await controlBarrier.enterLegacy({ reason: 'legacy-take', decoderSessionId: request.decoderSessionId });
    } catch (error) {
      active = null;
      leaseManager.release({ ...lease, leaseToken: lease.leaseToken });
      throw error;
    }
    active = leaseManager.get(RESOURCE);
    if (active?.leaseToken !== lease.leaseToken || active.expiresAt <= clock.now()) {
      leaseManager.release({ ...lease, leaseToken: lease.leaseToken });
      active = lease;
      await restoreForLease(lease, 'legacy-expired');
      throw new Error('LEGACY_LEASE_LOST');
    }
    return Object.freeze({ ...acquired, decoderSessionId: request.decoderSessionId });
  }
  function takeLegacy(request = {}) { return serialize(() => takeLegacyNow(request)); }

  function heartbeat(request = {}) {
    if (!authorized(request)) return Object.freeze({ ok: false, code: 'maintenance_denied' });
    const result = leaseManager.heartbeat({ resource: RESOURCE, clientId: maintenanceClientId,
      connectionGeneration: request.decoderSessionId, leaseToken: request.leaseToken });
    if (result.ok && active?.leaseToken === request.leaseToken) active = leaseManager.get(RESOURCE);
    else if (result.code === 'lease_expired' && active?.leaseToken === request.leaseToken
        && active.connectionGeneration === request.decoderSessionId) {
      const expired = active;
      serialize(() => restoreForLease(expired, 'legacy-expired')).catch(() => {});
    }
    return result;
  }

  async function restoreForLease(lease, reason) {
    if (!lease || active?.leaseToken !== lease.leaseToken) return false;
    legacyAccess.rejectWrites(reason);
    await controlBarrier.restoreWorld(reason);
    active = null;
    return true;
  }

  async function releaseLegacyNow(request) {
    if (!authorized(request)) return Object.freeze({ ok: false, code: 'maintenance_denied' });
    const released = leaseManager.release({ resource: RESOURCE,
      clientId: maintenanceClientId,
      connectionGeneration: request.decoderSessionId, leaseToken: request.leaseToken });
    if (released.ok && released.released) await restoreForLease(released.lease, 'legacy-release');
    return released;
  }
  function releaseLegacy(request = {}) { return serialize(() => releaseLegacyNow(request)); }

  async function decoderDisconnectedNow(decoderSessionId) {
    const lease = leaseManager.get(RESOURCE);
    if (!lease || lease.connectionGeneration !== decoderSessionId) return false;
    leaseManager.release({ ...lease, leaseToken: lease.leaseToken });
    return restoreForLease(lease, 'legacy-disconnect');
  }
  function decoderDisconnected(decoderSessionId) {
    return serialize(() => decoderDisconnectedNow(decoderSessionId));
  }

  async function expireNow(nowMs) {
    const expired = leaseManager.expireMatching(nowMs, (resource) => resource === RESOURCE);
    for (const lease of expired) await restoreForLease(lease, 'legacy-expired');
    return expired;
  }
  function expire(nowMs) { return serialize(() => expireNow(nowMs ?? clock.now())); }

  return Object.freeze({ takeLegacy, heartbeat, releaseLegacy, decoderDisconnected, expire,
    owns: (decoderSessionId) => Boolean(active && legacyAccess.isAllowed(decoderSessionId)
      && active.connectionGeneration === decoderSessionId
      && active.expiresAt > clock.now()),
    getStatus: () => Object.freeze({ audioOwner: active ? 'legacy' : 'world',
      decoderSessionId: active?.connectionGeneration ?? null,
      expiresAt: active?.expiresAt ?? null }) });
}
