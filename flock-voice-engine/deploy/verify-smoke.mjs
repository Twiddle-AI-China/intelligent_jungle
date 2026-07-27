import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from '../runtime/node_modules/ws/wrapper.mjs';

const base = process.argv[2];
if (base !== 'http://127.0.0.1:18090') throw new Error('LOOPBACK_CANDIDATE_URL_REQUIRED');
const origin = 'http://127.0.0.1:4193';
const timeout = () => AbortSignal.timeout(5000);
const bootstrapResponse = await fetch(`${base}/api/v1/bootstrap`, {
  headers: { origin }, signal: timeout(),
});
assert.equal(bootstrapResponse.status, 200, 'BOOTSTRAP_SMOKE_FAILED');
const bootstrap = await bootstrapResponse.json();
assert.equal(typeof bootstrap.worldGeneration, 'string');
assert.equal(bootstrap.snapshot.worldGeneration, bootstrap.worldGeneration);

const wsBase = base.replace('http:', 'ws:');
const runtime = new WebSocket(`${wsBase}/api/v1/runtime`, { origin });
await once(runtime, 'open', { signal: timeout() });
runtime.send(JSON.stringify({ type: 'hello', protocolVersion: 1, clientId: bootstrap.clientId,
  bootstrapToken: bootstrap.bootstrapToken, worldGeneration: bootstrap.worldGeneration,
  lastRevision: bootstrap.revision, lastEventSeq: bootstrap.eventSeq }));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('RUNTIME_WS_READY_TIMEOUT')), 5000);
  runtime.on('message', (data, binary) => {
    if (binary) return;
    const frame = JSON.parse(data.toString());
    if (frame.type === 'ready') { clearTimeout(timer); resolve(); }
  });
  runtime.on('error', reject);
});

const audio = new WebSocket(`${wsBase}/api/v1/audio`, { origin });
const audioFrames = [];
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('AUDIO_WS_CURSOR_TIMEOUT')), 5000);
  audio.on('message', (data, binary) => {
    audioFrames.push(binary ? Buffer.from(data) : JSON.parse(data.toString()));
    if (audioFrames.length >= 2) { clearTimeout(timer); resolve(); }
  });
  audio.on('error', reject);
});
assert.equal(audioFrames[0].type, 'audio.ready');
assert.equal(audioFrames[0].resumeStartFrame, audioFrames[1].readBigUInt64LE(16).toString());
assert.equal(audioFrames[0].blockSeq, audioFrames[1].readUInt32LE(12));

const legacy = new WebSocket(`${wsBase}/decoder`, { origin });
await once(legacy, 'open', { signal: timeout() });
const rejected = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('LEGACY_READ_ONLY_TIMEOUT')), 5000);
  legacy.on('message', (data, binary) => {
    if (binary) return;
    const frame = JSON.parse(data.toString());
    if (frame.type === 'error') { clearTimeout(timer); resolve(frame); }
  });
  legacy.on('error', reject);
});
legacy.send(JSON.stringify({ type: 'note', voice: 0, midi: 60, velocity: 1, durationSeconds: 1 }));
assert.equal((await rejected).code, 'LEGACY_LEASE_REQUIRED');
for (const socket of [runtime, audio, legacy]) socket.close();
