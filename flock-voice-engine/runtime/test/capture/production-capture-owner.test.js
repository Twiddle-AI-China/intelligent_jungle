import assert from 'node:assert/strict';
import { types } from 'node:util';
import test from 'node:test';

import {
  createProductionCaptureOwner,
} from '../../src/capture/production-capture-owner.js';

test('production capture owner starts without Phase 5 authority and remains inert', async () => {
  const owner = createProductionCaptureOwner();
  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(Object.keys(owner), ['start', 'close', 'waitForFailure']);
  assert.equal(await owner.start(), true);
  assert.equal(await owner.close(), true);
  const failure = owner.waitForFailure();
  assert.equal(types.isPromise(failure), true);
  assert.equal(Object.getPrototypeOf(failure), Promise.prototype);
  assert.equal(Object.hasOwn(failure, 'then'), false);
  assert.equal(Object.hasOwn(failure, 'constructor'), false);
});
