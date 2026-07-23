import assert from 'node:assert/strict';
import test from 'node:test';

import { createMailbox } from '../src/world-session/mailbox.js';

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('executes posted operations in explicit FIFO order without overlap', async () => {
  const mailbox = createMailbox();
  const gate = createDeferred();
  const started = createDeferred();
  const order = [];

  const slow = mailbox.post('slow', async () => {
    order.push('slow:start');
    started.resolve();
    await gate.promise;
    order.push('slow:end');
  });
  const fast = mailbox.post('fast', async () => {
    order.push('fast');
  });

  await started.promise;
  assert.deepEqual(order, ['slow:start']);

  gate.resolve();
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['slow:start', 'slow:end', 'fast']);
});

test('rejects a failed operation without poisoning later posts', async () => {
  const mailbox = createMailbox();
  const broken = mailbox.post('broken', () => {
    throw new Error('boom');
  });
  const afterError = mailbox.post('after-error', () => 7);

  await assert.rejects(broken, /boom/);
  assert.equal(await afterError, 7);
});
