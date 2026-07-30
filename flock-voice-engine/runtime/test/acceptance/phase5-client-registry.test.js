import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _createPhase5ClientRegistry,
  PHASE5_CLIENT_CAPABILITY_HEADER,
  Phase5ClientRegistryError,
} from '../../src/acceptance/phase5-client-registry.js';

const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';

function fixture() {
  let sequence = 0;
  const registry = _createPhase5ClientRegistry({
    runId: RUN_ID,
    randomBytes(size) {
      assert.equal(size, 32);
      sequence += 1;
      return Buffer.alloc(32, sequence);
    },
  });
  return { registry };
}

function errorCode(code) {
  return (error) => (
    error instanceof Phase5ClientRegistryError
    && error.code === code
  );
}

test('initial admission yields four distinct identities and eight opaque grants', () => {
  const { registry } = fixture();
  const grants = registry.getInitialCapabilities();

  assert.equal(PHASE5_CLIENT_CAPABILITY_HEADER,
    'x-flock-phase5-client-capability');
  assert.deepEqual(grants.map(({ client }) => client), [1, 2, 3, 4]);
  assert.equal(new Set(grants.map(
    ({ clientIdentitySha256 }) => clientIdentitySha256,
  )).size, 4);
  assert.equal(new Set(grants.flatMap((grant) => [
    grant.runtimeCapability,
    grant.audioCapability,
  ])).size, 8);
  assert.equal(grants.every((grant) => (
    grant.runtimeGeneration === 1
    && grant.audioGeneration === 1
  )), true);
  assert.throws(
    () => registry.getInitialCapabilities(),
    errorCode('PHASE5_CLIENT_REGISTRY_ADMISSION_USED'),
  );
});

test('runtime and audio grants bind one identity but cannot be interchanged', () => {
  const { registry } = fixture();
  const [client] = registry.getInitialCapabilities();

  assert.throws(
    () => registry.claim({
      socketKind: 'audio',
      capability: client.runtimeCapability,
    }),
    errorCode('PHASE5_CLIENT_CAPABILITY_INVALID'),
  );
  const runtime = registry.claim({
    socketKind: 'runtime',
    capability: client.runtimeCapability,
  });
  const audio = registry.claim({
    socketKind: 'audio',
    capability: client.audioCapability,
  });
  assert.equal(runtime.client, 1);
  assert.equal(audio.client, 1);
  assert.equal(runtime.clientIdentitySha256, audio.clientIdentitySha256);
  assert.equal(runtime.generation, 1);
  assert.equal(audio.generation, 1);
  assert.throws(
    () => registry.claim({
      socketKind: 'runtime',
      capability: client.runtimeCapability,
    }),
    errorCode('PHASE5_CLIENT_CAPABILITY_INVALID'),
  );
});

test('reconnect preserves identity and consumes exactly the next generation grant', () => {
  const { registry } = fixture();
  const [client] = registry.getInitialCapabilities();
  const first = registry.claim({
    socketKind: 'runtime',
    capability: client.runtimeCapability,
  });
  const reconnect = registry.close({
    client: first.client,
    socketKind: first.socketKind,
    generation: first.generation,
  });
  assert.equal(reconnect.generation, 2);
  assert.equal(reconnect.clientIdentitySha256, first.clientIdentitySha256);
  const second = registry.claim({
    socketKind: 'runtime',
    capability: reconnect.capability,
  });
  assert.equal(second.generation, 2);
  assert.equal(second.clientIdentitySha256, first.clientIdentitySha256);
});

test('wrong generation, duplicate close and terminal grants fail closed', () => {
  const { registry } = fixture();
  const [client] = registry.getInitialCapabilities();
  const claimed = registry.claim({
    socketKind: 'audio',
    capability: client.audioCapability,
  });
  assert.throws(
    () => registry.close({
      client: claimed.client,
      socketKind: claimed.socketKind,
      generation: 2,
    }),
    errorCode('PHASE5_CLIENT_REGISTRY_CLOSE_INVALID'),
  );
  const reconnect = registry.close({
    client: claimed.client,
    socketKind: claimed.socketKind,
    generation: claimed.generation,
  });
  assert.throws(
    () => registry.close({
      client: claimed.client,
      socketKind: claimed.socketKind,
      generation: claimed.generation,
    }),
    errorCode('PHASE5_CLIENT_REGISTRY_CLOSE_INVALID'),
  );
  registry.terminate();
  assert.throws(
    () => registry.claim({
      socketKind: 'audio',
      capability: reconnect.capability,
    }),
    errorCode('PHASE5_CLIENT_CAPABILITY_INVALID'),
  );
});

test('random collisions fail before any capability can escape', () => {
  assert.throws(() => _createPhase5ClientRegistry({
    runId: RUN_ID,
    randomBytes: (size) => Buffer.alloc(size, 1),
  }), /PHASE5_CLIENT_REGISTRY_RANDOM_INVALID/u);
});
