import assert from 'node:assert/strict';
import test from 'node:test';

import { WorldSessionRegistry } from '../src/world-session/session-registry.js';

test('memoizes exactly one default world session', () => {
  const expected = Object.freeze({ worldId: 'default' });
  let createCount = 0;
  const registry = new WorldSessionRegistry({
    createSession() {
      createCount += 1;
      return expected;
    },
  });

  assert.equal(createCount, 0);
  assert.equal(registry.get('default'), expected);
  assert.equal(registry.get('default'), expected);
  assert.equal(createCount, 1);
});

test('rejects every non-default world without creating a session', () => {
  let createCount = 0;
  const registry = new WorldSessionRegistry({
    createSession() {
      createCount += 1;
      return {};
    },
  });

  for (const worldId of ['other', '', undefined, null, 0]) {
    assert.throws(() => registry.get(worldId), /WORLD_NOT_SUPPORTED/);
  }
  assert.equal(createCount, 0);
});

test('requires an injected session factory', () => {
  assert.throws(
    () => new WorldSessionRegistry({ createSession: undefined }),
    /WORLD_SESSION_FACTORY_REQUIRED/,
  );
});
