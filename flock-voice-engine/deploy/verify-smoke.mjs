import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Agent, get } from 'node:http';
import WebSocket from '../runtime/node_modules/ws/wrapper.mjs';

const base = process.argv[2];
if (base !== 'http://127.0.0.1:18090') throw new Error('LOOPBACK_CANDIDATE_URL_REQUIRED');
const origin = base;
const timeout = () => AbortSignal.timeout(5000);
const authority = '127.0.0.1:18090';
const httpAgent = new Agent({ keepAlive: false, localAddress: '127.0.0.1' });
const websocketAgent = new Agent({ keepAlive: false, localAddress: '127.0.0.1' });
const sockets = [];
async function getBrowserJson(path, failureCode) {
  const result = await new Promise((resolve, reject) => {
    const request = get({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: 18090,
      path,
      agent: httpAgent,
      headers: { Host: authority, Origin: origin },
      signal: timeout(),
    }, (response) => {
      const chunks = [];
      let byteCount = 0;
      response.on('data', (chunk) => {
        byteCount += chunk.length;
        if (byteCount > 65536) {
          response.destroy(new Error('SMOKE_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('aborted', () => reject(new Error('SMOKE_RESPONSE_ABORTED')));
      response.once('error', reject);
      response.once('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
  });
  assert.equal(result.status, 200, failureCode);
  return JSON.parse(result.body);
}
try {
const bootstrap = await getBrowserJson('/api/v1/bootstrap', 'BOOTSTRAP_SMOKE_FAILED');
assert.equal(typeof bootstrap.worldGeneration, 'string');
assert.equal(bootstrap.snapshot.worldGeneration, bootstrap.worldGeneration);
await getBrowserJson('/api/decoder-status', 'DECODER_STATUS_SMOKE_FAILED');

const wsBase = base.replace('http:', 'ws:');
const websocketOptions = {
  origin,
  agent: websocketAgent,
  followRedirects: false,
  handshakeTimeout: 5000,
};
const runtime = new WebSocket(`${wsBase}/api/v1/runtime`, websocketOptions);
sockets.push(runtime);
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

const audio = new WebSocket(`${wsBase}/api/v1/audio`, websocketOptions);
sockets.push(audio);
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

const legacy = new WebSocket(`${wsBase}/decoder`, websocketOptions);
sockets.push(legacy);
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
} finally {
  for (const socket of sockets) {
    socket.on('error', () => {});
    try { socket.terminate(); } catch { /* bounded smoke cleanup is authoritative */ }
  }
  httpAgent.destroy();
  websocketAgent.destroy();
}
