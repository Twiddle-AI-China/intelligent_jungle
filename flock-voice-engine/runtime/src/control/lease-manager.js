import { randomUUID } from 'node:crypto';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const RESOURCE = /^[a-z][a-z0-9.-]{0,63}:[a-z][a-z0-9_-]{0,63}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TOKEN_TOMBSTONE_CAPACITY = 4_096;

function validIdentity(value) {
  return typeof value === 'string' && IDENTITY.test(value);
}

export function createLeaseManager({
  clock,
  tokenFactory = randomUUID,
  defaultTtlMs = 3_000,
  maxTtlMs = 10_000,
} = {}) {
  if (typeof clock?.now !== 'function' || typeof tokenFactory !== 'function'
    || !Number.isSafeInteger(defaultTtlMs) || defaultTtlMs <= 0
    || !Number.isSafeInteger(maxTtlMs) || maxTtlMs < defaultTtlMs) {
    throw new Error('LEASE_MANAGER_CONFIG_INVALID');
  }
  const leases = new Map();
  const issuedTokens = new Set();
  const tokenTombstones = [];

  function now() {
    const value = clock.now();
    if (!Number.isFinite(value) || value < 0) throw new Error('LEASE_CLOCK_INVALID');
    return value;
  }

  function validRequest({ resource, clientId, connectionGeneration } = {}) {
    return typeof resource === 'string' && RESOURCE.test(resource)
      && validIdentity(clientId) && validIdentity(connectionGeneration);
  }

  function publicState(lease) {
    return lease
      ? deepFreeze({
        held: true,
        expiresAt: lease.expiresAt,
      })
      : deepFreeze({ held: false, expiresAt: null });
  }

  function immutableResult(value) {
    return deepFreeze(value);
  }

  function take(request = {}) {
    const ttlMs = request.ttlMs === undefined ? defaultTtlMs : request.ttlMs;
    if (!validRequest(request) || !Number.isSafeInteger(ttlMs)
      || ttlMs <= 0 || ttlMs > maxTtlMs) {
      return immutableResult({ ok: false, code: 'invalid_lease' });
    }
    const currentTime = now();
    const existing = leases.get(request.resource);
    if (existing && existing.expiresAt <= currentTime) leases.delete(request.resource);
    const active = leases.get(request.resource);
    if (active) {
      if (active.clientId === request.clientId
        && active.connectionGeneration === request.connectionGeneration) {
        return immutableResult({
          ok: true, code: 'already_held', leaseToken: active.leaseToken,
          expiresAt: active.expiresAt,
        });
      }
      return immutableResult({ ok: false, code: 'lease_conflict', owner: publicState(active) });
    }
    let leaseToken;
    try { leaseToken = tokenFactory(); } catch { return immutableResult({ ok: false, code: 'token_unavailable' }); }
    if (!validIdentity(leaseToken) || issuedTokens.has(leaseToken)
      || [...leases.values()].some((lease) => lease.leaseToken === leaseToken)) {
      return immutableResult({ ok: false, code: 'token_unavailable' });
    }
    issuedTokens.add(leaseToken);
    tokenTombstones.push(leaseToken);
    if (tokenTombstones.length > TOKEN_TOMBSTONE_CAPACITY) {
      issuedTokens.delete(tokenTombstones.shift());
    }
    const lease = deepFreeze({
      resource: request.resource,
      clientId: request.clientId,
      connectionGeneration: request.connectionGeneration,
      leaseToken,
      ttlMs,
      expiresAt: currentTime + ttlMs,
    });
    leases.set(request.resource, lease);
    return immutableResult({ ok: true, code: 'ok', leaseToken, expiresAt: lease.expiresAt });
  }

  function matches(lease, request) {
    return lease.clientId === request.clientId
      && lease.connectionGeneration === request.connectionGeneration
      && lease.leaseToken === request.leaseToken;
  }

  function heartbeat(request = {}) {
    if (!validRequest(request) || !validIdentity(request.leaseToken)) {
      return immutableResult({ ok: false, code: 'invalid_lease' });
    }
    const currentTime = now();
    const lease = leases.get(request.resource);
    if (!lease || lease.expiresAt <= currentTime) {
      if (lease) leases.delete(request.resource);
      return immutableResult({ ok: false, code: 'lease_expired' });
    }
    if (!matches(lease, request)) return immutableResult({ ok: false, code: 'lease_mismatch' });
    const renewed = deepFreeze({ ...lease, expiresAt: currentTime + lease.ttlMs });
    leases.set(request.resource, renewed);
    return immutableResult({ ok: true, code: 'ok', expiresAt: renewed.expiresAt });
  }

  function release(request = {}) {
    if (!validRequest(request) || !validIdentity(request.leaseToken)) {
      return immutableResult({ ok: false, code: 'invalid_lease', released: false });
    }
    const lease = leases.get(request.resource);
    if (!lease) return immutableResult({ ok: true, code: 'ok', released: false });
    if (!matches(lease, request)) {
      return immutableResult({ ok: false, code: 'lease_mismatch', released: false });
    }
    leases.delete(request.resource);
    return immutableResult({ ok: true, code: 'ok', released: true, lease });
  }

  function disconnect({ clientId, connectionGeneration } = {}) {
    if (!validIdentity(clientId) || !validIdentity(connectionGeneration)) return Object.freeze([]);
    const released = [];
    for (const [resource, lease] of leases) {
      if (lease.clientId !== clientId || lease.connectionGeneration !== connectionGeneration) continue;
      leases.delete(resource);
      released.push(lease);
    }
    return deepFreeze(released);
  }

  function expire(nowMs = now()) {
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error('LEASE_CLOCK_INVALID');
    const released = [];
    for (const [resource, lease] of leases) {
      if (lease.expiresAt > nowMs) continue;
      leases.delete(resource);
      released.push(lease);
    }
    return deepFreeze(released);
  }

  function get(resource) {
    return leases.get(resource) ?? null;
  }

  function getPublicState(resource) {
    return publicState(leases.get(resource));
  }

  return Object.freeze({ take, heartbeat, release, disconnect, expire, get, getPublicState });
}
