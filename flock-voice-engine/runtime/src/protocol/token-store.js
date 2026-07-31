import { randomBytes as nodeRandomBytes } from 'node:crypto';

const CLAIM_KEYS = Object.freeze([
  'worldId',
  'worldGeneration',
  'clientId',
  'revision',
  'eventSeq',
  'kind',
]);

function nowFrom(clock) {
  return typeof clock === 'function' ? clock() : clock.now();
}

function sameExpectedClaims(stored, expected) {
  return CLAIM_KEYS.every((key) => (
    expected[key] === undefined || stored[key] === expected[key]
  ));
}

export function createTokenStore({
  clock = { now: () => Date.now() },
  randomBytes = nodeRandomBytes,
  // The token is one-shot and claim-bound.  A one minute lifetime leaves enough
  // room for a congested public proxy/tunnel to complete bootstrap + WS attach
  // without weakening replay protection.
  ttlMs = 60_000,
  capacity = 4_096,
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('TOKEN_TTL_INVALID');
  }
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error('TOKEN_CAPACITY_INVALID');
  }

  let tokens = new Map();

  function purgeExpired(now) {
    for (const [token, stored] of tokens) {
      if (stored.expiresAt <= now) tokens.delete(token);
    }
  }

  function opaqueToken(forbidden) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const token = randomBytes(32).toString('base64url');
      if (!forbidden.has(token)) return token;
    }
    throw new Error('TOKEN_COLLISION');
  }

  function storeClaims(claims, expiresAt) {
    const stored = {};
    for (const key of CLAIM_KEYS) stored[key] = claims[key];
    stored.expiresAt = expiresAt;
    return stored;
  }

  return Object.freeze({
    issue(claims) {
      const now = nowFrom(clock);
      purgeExpired(now);
      if (tokens.size >= capacity) {
        throw new Error('TOKEN_CAPACITY_EXCEEDED');
      }
      const token = opaqueToken(tokens);
      const expiresAt = now + ttlMs;
      const stored = storeClaims(claims, expiresAt);
      tokens.set(token, stored);
      return Object.freeze({ token, expiresAt });
    },

    consume(token, expected = {}) {
      const stored = tokens.get(token);
      if (!stored) return null;
      tokens.delete(token);
      if (stored.expiresAt <= nowFrom(clock)) return null;
      if (!sameExpectedClaims(stored, expected)) return null;
      return Object.freeze(structuredClone(stored));
    },

    prepareRotation(claimSets) {
      if (!Array.isArray(claimSets) || claimSets.length > capacity) {
        throw new Error('TOKEN_ROTATION_CAPACITY_EXCEEDED');
      }
      const expiresAt = nowFrom(clock) + ttlMs;
      const staged = new Map();
      const forbidden = new Set(tokens.keys());
      const issued = claimSets.map((claims) => {
        const token = opaqueToken(forbidden);
        forbidden.add(token);
        staged.set(token, storeClaims(claims, expiresAt));
        return Object.freeze({ token, expiresAt });
      });
      let committed = false;
      return Object.freeze({
        issued: Object.freeze(issued),
        commit() {
          if (committed) return false;
          tokens = staged;
          committed = true;
          return true;
        },
      });
    },

    clear() {
      tokens.clear();
    },
  });
}
