import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { decodeU64Decimal, encodeU64Decimal, assertExactAudioGeometry,
  connectWorkerProtocol } from '../../src/audio/worker-protocol.js';

const golden = JSON.parse(readFileSync(new URL('../../../tests/fixtures/worker-protocol-u64-golden.json', import.meta.url)));
test('private JSON u64 codec matches handwritten shared golden', () => {
  for (const item of golden) {
    assert.equal(encodeU64Decimal(BigInt(item.value)), item.wire);
    assert.equal(decodeU64Decimal(item.wire), BigInt(item.value));
  }
  for (const bad of [1, '-1', '+1', '01', '1e2', ' 1', '18446744073709551616']) {
    assert.throws(() => decodeU64Decimal(bad));
  }
});
test('geometry supports alternate manifest data and rejects mismatch', () => {
  const geometry = { sampleRate: 48000, blockFrames: 2048, poolSize: 3, rowVoices: ['bass', 'lead', 'pluck'] };
  assert.doesNotThrow(() => assertExactAudioGeometry(geometry, structuredClone(geometry)));
  assert.throws(() => assertExactAudioGeometry(geometry, { ...geometry, sampleRate: 44100 }));
});

test('blocked writer stays bounded and coalesces only queued continuous state', () => {
  class Socket extends EventEmitter {
    callbacks = [];
    write(_frame, callback) { this.callbacks.push(callback); return false; }
    destroy() {}
  }
  const socket = new Socket();
  const scheduled = [];
  const protocol = connectWorkerProtocol(socket, { outboundCapacity: 2,
    scheduleWriter: (operation) => scheduled.push(operation) });
  const batch = (seq, value) => ({ type: 'audio.command.batch', audioEpoch: 'e', commandSeq: seq,
    targetFrame: '0', commands: [{ type: 'continuous.set', voice: 'pad', param: 'gain', value }] });
  assert.equal(protocol.enqueueBatch(batch(1, .1)).accepted, true);
  assert.equal(socket.callbacks.length, 0);
  scheduled.shift()();
  assert.equal(protocol.enqueueBatch(batch(2, .2)).accepted, true);
  assert.equal(protocol.enqueueBatch(batch(3, .3)).coalesced, true);
  assert.equal(protocol.outboundQueueDepth, 2);
  assert.deepEqual(protocol.enqueueBatch({ ...batch(4, .4), commands: [{ type: 'note.on' }] }),
    { accepted: false, reason: 'RUNTIME_AUDIO_OUTBOUND_OVERFLOW' });
});

test('unexpected socket close is observable by the supervisor subscriber', () => {
  class Socket extends EventEmitter { write() { return true; } destroy() {} }
  const socket = new Socket();
  const protocol = connectWorkerProtocol(socket);
  const seen = [];
  protocol.subscribe((message) => seen.push(message.type));
  socket.emit('close');
  assert.deepEqual(seen, ['worker.connection.closed']);
});

test('subscribed PCM is drained once and never retained in the waiter backlog', async () => {
  class Socket extends EventEmitter { write() { return true; } destroy() {} }
  const socket = new Socket();
  const protocol = connectWorkerProtocol(socket);
  let count = 0;
  protocol.subscribe((message) => { if (message.type === 'pcm.master') count += 1; });
  const body = Buffer.alloc(16 + 8);
  body.writeUInt32LE(1, 8); body.writeUInt16LE(2, 12); body.writeUInt16LE(1, 14);
  const frame = Buffer.alloc(5 + body.length);
  frame.writeUInt32BE(body.length, 0); frame[4] = 2; body.copy(frame, 5);
  socket.emit('data', frame);
  assert.equal(count, 1);
  await assert.rejects(protocol.next((message) => message.type === 'pcm.master', 1),
    /WORKER_PROTOCOL_TIMEOUT/);
});
