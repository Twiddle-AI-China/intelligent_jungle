import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { types } from 'node:util';

export const PHASE5_CLIENT_CAPABILITY_HEADER =
  'x-flock-phase5-client-capability';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SOCKET_KINDS = new Set(['runtime', 'audio']);
const CLAIM_FIELDS = Object.freeze(['socketKind', 'capability']);
const CLOSE_FIELDS = Object.freeze([
  'client', 'socketKind', 'generation',
]);

function fail(code) {
  throw new Phase5ClientRegistryError(code);
}

function enumerableDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, 'value')
    && !Object.hasOwn(descriptor, 'get')
    && !Object.hasOwn(descriptor, 'set');
}

function exactPlainDataObject(value, fields) {
  if (value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length
    && keys.every((key) => typeof key === 'string')
    && fields.every((key) => (
      keys.includes(key) && enumerableDataProperty(value, key)
    ));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function dataPropertyValue(value, key) {
  return Object.getOwnPropertyDescriptor(value, key).value;
}

function capabilityBytes(value) {
  if (typeof value !== 'string' || value.length !== 43) {
    fail('PHASE5_CLIENT_CAPABILITY_INVALID');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== value) {
    fail('PHASE5_CLIENT_CAPABILITY_INVALID');
  }
  return bytes;
}

function ownedBytes(randomBytes) {
  let value;
  try {
    value = Reflect.apply(randomBytes, undefined, [32]);
  } catch {
    fail('PHASE5_CLIENT_REGISTRY_RANDOM_INVALID');
  }
  if (!Buffer.isBuffer(value)
      || Object.getPrototypeOf(value) !== Buffer.prototype
      || value.byteLength !== 32) {
    fail('PHASE5_CLIENT_REGISTRY_RANDOM_INVALID');
  }
  return Buffer.from(value);
}

export class Phase5ClientRegistryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Phase5ClientRegistryError';
    this.code = code;
  }
}

export function _createPhase5ClientRegistry(options) {
  if (arguments.length !== 1
      || !exactPlainDataObject(options, ['runId', 'randomBytes'])) {
    fail('PHASE5_CLIENT_REGISTRY_INPUT_INVALID');
  }
  const runId = dataPropertyValue(options, 'runId');
  const randomBytes = dataPropertyValue(options, 'randomBytes');
  if (typeof runId !== 'string'
      || !UUID_V4.test(runId)
      || typeof randomBytes !== 'function'
      || types.isProxy(randomBytes)) {
    fail('PHASE5_CLIENT_REGISTRY_INPUT_INVALID');
  }
  const clients = new Map();
  const grantsByDigest = new Map();
  let admissionTaken = false;
  let terminal = false;

  function issueGrant(client, socketKind, generation) {
    const raw = ownedBytes(randomBytes);
    const capability = raw.toString('base64url');
    const digest = sha256(raw);
    raw.fill(0);
    if (grantsByDigest.has(digest)) {
      terminal = true;
      fail('PHASE5_CLIENT_REGISTRY_RANDOM_INVALID');
    }
    const grant = {
      client,
      socketKind,
      generation,
      digest,
      consumed: false,
    };
    grantsByDigest.set(digest, grant);
    return capability;
  }

  for (let client = 1; client <= 4; client += 1) {
    const identityBytes = ownedBytes(randomBytes);
    const value = {
      client,
      clientIdentitySha256: sha256(identityBytes),
      runtime: {
        generation: 1,
        open: false,
        capability: issueGrant(client, 'runtime', 1),
      },
      audio: {
        generation: 1,
        open: false,
        capability: issueGrant(client, 'audio', 1),
      },
    };
    if ([...clients.values()].some((existing) => (
      existing.clientIdentitySha256 === value.clientIdentitySha256
    ))) {
      terminal = true;
      fail('PHASE5_CLIENT_REGISTRY_RANDOM_INVALID');
    }
    identityBytes.fill(0);
    clients.set(client, value);
  }

  function getInitialCapabilities(...args) {
    if (terminal || admissionTaken || args.length !== 0) {
      fail('PHASE5_CLIENT_REGISTRY_ADMISSION_USED');
    }
    admissionTaken = true;
    return Object.freeze([...clients.values()].map((value) => Object.freeze({
      client: value.client,
      clientIdentitySha256: value.clientIdentitySha256,
      runtimeCapability: value.runtime.capability,
      runtimeGeneration: value.runtime.generation,
      audioCapability: value.audio.capability,
      audioGeneration: value.audio.generation,
    })));
  }

  function claim(options) {
    if (terminal || arguments.length !== 1
        || !exactPlainDataObject(options, CLAIM_FIELDS)) {
      fail('PHASE5_CLIENT_CAPABILITY_INVALID');
    }
    const socketKind = options.socketKind;
    if (!SOCKET_KINDS.has(socketKind)) {
      fail('PHASE5_CLIENT_CAPABILITY_INVALID');
    }
    const bytes = capabilityBytes(options.capability);
    const digest = sha256(bytes);
    bytes.fill(0);
    const grant = grantsByDigest.get(digest);
    if (!grant
        || grant.consumed
        || grant.socketKind !== socketKind) {
      fail('PHASE5_CLIENT_CAPABILITY_INVALID');
    }
    const client = clients.get(grant.client);
    const channel = client[socketKind];
    if (channel.open || channel.generation !== grant.generation) {
      fail('PHASE5_CLIENT_CAPABILITY_INVALID');
    }
    grant.consumed = true;
    grantsByDigest.delete(digest);
    channel.capability = null;
    channel.open = true;
    return Object.freeze({
      runId,
      client: client.client,
      clientIdentitySha256: client.clientIdentitySha256,
      socketKind,
      generation: channel.generation,
    });
  }

  function close(options) {
    if (terminal || arguments.length !== 1
        || !exactPlainDataObject(options, CLOSE_FIELDS)
        || !Number.isSafeInteger(options.client)
        || options.client < 1
        || options.client > 4
        || !SOCKET_KINDS.has(options.socketKind)
        || !Number.isSafeInteger(options.generation)
        || options.generation < 1) {
      fail('PHASE5_CLIENT_REGISTRY_CLOSE_INVALID');
    }
    const client = clients.get(options.client);
    const channel = client[options.socketKind];
    if (!channel.open || channel.generation !== options.generation) {
      fail('PHASE5_CLIENT_REGISTRY_CLOSE_INVALID');
    }
    channel.open = false;
    channel.generation += 1;
    channel.capability = issueGrant(
      client.client,
      options.socketKind,
      channel.generation,
    );
    return Object.freeze({
      runId,
      client: client.client,
      clientIdentitySha256: client.clientIdentitySha256,
      socketKind: options.socketKind,
      generation: channel.generation,
      capability: channel.capability,
    });
  }

  function terminate(...args) {
    if (args.length !== 0) fail('PHASE5_CLIENT_REGISTRY_INPUT_INVALID');
    terminal = true;
    grantsByDigest.clear();
    for (const client of clients.values()) {
      client.runtime.capability = null;
      client.audio.capability = null;
    }
  }

  return Object.freeze({
    getInitialCapabilities,
    claim,
    close,
    terminate,
  });
}

export function createPhase5ClientRegistry(options = {}) {
  if (arguments.length !== 1
      || !exactPlainDataObject(options, ['runId'])) {
    fail('PHASE5_CLIENT_REGISTRY_INPUT_INVALID');
  }
  return _createPhase5ClientRegistry({
    runId: dataPropertyValue(options, 'runId'),
    randomBytes: (size) => cryptoRandomBytes(size),
  });
}
