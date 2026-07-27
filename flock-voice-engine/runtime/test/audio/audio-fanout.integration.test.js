import assert from 'node:assert/strict';
import test from 'node:test';
import { createAudioClientWriter } from '../../src/audio/audio-client-writer.js';
import { createPcmRing } from '../../src/audio/pcm-ring.js';

class FakeSocket {
  constructor({ pauseBinary = false, sendError = null } = {}) { this.pauseBinary = pauseBinary;
    this.sendError = sendError; this.binary = []; this.json = []; this.blocked = [];
    this.closeCalls = []; }
  send(data, options, callback) {
    if (options.binary) this.binary.push(data); else this.json.push(JSON.parse(data));
    if (this.sendError) { const error = this.sendError; this.sendError = null; callback(error); }
    else if (options.binary && this.pauseBinary) this.blocked.push(callback); else callback();
  }
  release() { this.pauseBinary = false; while (this.blocked.length) this.blocked.shift()(); }
  close(code, reason) { this.closeCalls.push({ code, reason }); }
}

function block(index) { return { startFrame: BigInt(index * 64), frameCount: 64, channels: 2, format: 1,
  payload: Buffer.alloc(64 * 2 * 4) }; }
const ready = () => ({ manifestGeometrySha256: 'a'.repeat(64), sampleRate: 6400,
  blockFrames: 64, channels: 2, format: 'f32le', binaryHeaderVersion: 1, headerBytes: 32 });

test('one paused client jumps alone and never stalls a hot client', () => {
  const ring = createPcmRing({ sampleRate: 6400, blockFrames: 64 });
  ring.beginStream({ audioEpoch: 'e', minStartFrame: 0n });
  const hot = new FakeSocket(); const paused = new FakeSocket({ pauseBinary: true });
  createAudioClientWriter({ socket: hot, ring, getAudioReady: ready, egressMs: 50 }).start();
  createAudioClientWriter({ socket: paused, ring, getAudioReady: ready, egressMs: 50 }).start();
  for (let index = 0; index < 80; index += 1) ring.publish(block(index));
  assert.equal(hot.binary.length, 80);
  paused.release();
  assert.ok(paused.json.some((frame) => frame.scope === 'client'));
  assert.equal(ring.getStatus().streamRevision, 1);
});

test('late subscriber ready cursor equals its first binary frame', () => {
  const ring = createPcmRing({ sampleRate: 6400, blockFrames: 64 });
  ring.beginStream({ audioEpoch: 'e', minStartFrame: 0n });
  for (let index = 0; index < 10; index += 1) ring.publish(block(index));
  const socket = new FakeSocket();
  createAudioClientWriter({ socket, ring, getAudioReady: ready }).start();
  const first = socket.binary[0];
  assert.equal(socket.json[0].resumeStartFrame, first.readBigUInt64LE(16).toString());
  assert.equal(socket.json[0].blockSeq, first.readUInt32LE(12));
});

test('late subscriber history is capped by its 500ms egress budget', () => {
  const ring = createPcmRing({ sampleRate: 6400, blockFrames: 64 });
  ring.beginStream({ audioEpoch: 'e', minStartFrame: 0n });
  for (let index = 0; index < 300; index += 1) ring.publish(block(index));
  const socket = new FakeSocket({ pauseBinary: true });
  const writer = createAudioClientWriter({ socket, ring, getAudioReady: ready, egressMs: 50 });
  writer.start();
  assert.equal(writer.getStatus().capacity, 5);
  assert.equal(writer.getStatus().queued, 4);
  assert.equal(socket.binary.length, 1);
  assert.equal(socket.json[0].blockSeq, 295);
});

test('send failure stops the writer and closes the socket so the client reconnects', () => {
  const ring = createPcmRing({ sampleRate: 6400, blockFrames: 64 });
  ring.beginStream({ audioEpoch: 'e', minStartFrame: 0n });
  const socket = new FakeSocket({ sendError: new Error('send failed') });
  const writer = createAudioClientWriter({ socket, ring, getAudioReady: ready });
  writer.start();
  assert.equal(writer.getStatus().stopped, true);
  assert.deepEqual(socket.closeCalls, [{ code: 1011, reason: 'AUDIO_SEND_FAILED' }]);
});

test('not-ready attach unsubscribes atomically', () => {
  let subscriptions = 0;
  const ring = { getStatus: () => ({ sampleRate: 6400, blockFrames: 64, audioEpoch: null }),
    attach() { subscriptions += 1; return { history: [], cursor: { streamRevision: 0,
      blockSeq: 0, startFrame: 0n }, unsubscribe: () => { subscriptions -= 1; } }; },
    getLiveCursor: () => ({ streamRevision: 0, blockSeq: 0, startFrame: 0n }) };
  const writer = createAudioClientWriter({ socket: new FakeSocket(), ring,
    getAudioReady: () => null });
  assert.throws(() => writer.start(), /AUDIO_STREAM_NOT_READY/);
  assert.equal(subscriptions, 0);
});
