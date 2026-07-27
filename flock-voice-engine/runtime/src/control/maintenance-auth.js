import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function frozen(value) { return Object.freeze(value); }
function validIdentity(value) { return typeof value === 'string' && IDENTITY.test(value); }

export function createMaintenanceAuth({
  secretPath = '/run/secrets/flock-maintenance-token',
  readSecret = (path) => readFileSync(path),
  tokenFactory = randomUUID,
} = {}) {
  let secret = null;
  try {
    const value = Buffer.from(readSecret(secretPath));
    if (value.length >= 32) secret = value;
  } catch { /* unavailable is a supported fail-closed mode */ }
  const grants = new Map();
  const connectionTokens = new Map();
  const issuedTokens = new Set();
  const tokenTombstones = [];
  const connectionKey = (clientId, generation) => `${clientId}\0${generation}`;

  function authenticate({ credential, clientId, connectionGeneration } = {}) {
    if (secret === null) return frozen({ ok: false, code: 'maintenance_unavailable' });
    if (!validIdentity(clientId) || !validIdentity(connectionGeneration)
        || typeof credential !== 'string') return frozen({ ok: false, code: 'maintenance_denied' });
    const candidate = Buffer.from(credential);
    if (candidate.length !== secret.length || !timingSafeEqual(candidate, secret)) {
      return frozen({ ok: false, code: 'maintenance_denied' });
    }
    let maintenanceToken;
    try { maintenanceToken = tokenFactory(); } catch { maintenanceToken = null; }
    if (!validIdentity(maintenanceToken) || issuedTokens.has(maintenanceToken)) {
      return frozen({ ok: false, code: 'maintenance_token_unavailable' });
    }
    issuedTokens.add(maintenanceToken); tokenTombstones.push(maintenanceToken);
    if (tokenTombstones.length > 4096) issuedTokens.delete(tokenTombstones.shift());
    const key = connectionKey(clientId, connectionGeneration);
    const prior = connectionTokens.get(key);
    if (prior) grants.delete(prior);
    grants.set(maintenanceToken, frozen({ clientId, connectionGeneration,
      resource: 'legacy-audio' }));
    connectionTokens.set(key, maintenanceToken);
    return frozen({ ok: true, code: 'ok', maintenanceToken });
  }

  function verify({ maintenanceToken, clientId, connectionGeneration,
    resource = 'legacy-audio' } = {}) {
    const grant = grants.get(maintenanceToken);
    return Boolean(grant && grant.clientId === clientId
      && grant.connectionGeneration === connectionGeneration && grant.resource === resource);
  }

  function revokeConnection({ clientId, connectionGeneration } = {}) {
    const key = connectionKey(clientId, connectionGeneration);
    const token = connectionTokens.get(key);
    if (token) grants.delete(token);
    connectionTokens.delete(key);
  }

  return frozen({ enabled: secret !== null, authenticate, verify, revokeConnection });
}
