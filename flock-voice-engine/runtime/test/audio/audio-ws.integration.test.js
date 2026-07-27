import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { createAudioWsGateway } from '../../src/api/audio-ws.js';
import { createPcmRing } from '../../src/audio/pcm-ring.js';
import { createCandidateServer } from '../../src/server.js';

const audio = { audioEpoch: 'epoch-real', manifestGeometrySha256: 'a'.repeat(64),
  sampleRate: 6400, blockFrames: 64, channels: 2, format: 'f32le',
  binaryHeaderVersion: 1, headerBytes: 32 };

test('real Audio WS sends ready before an exactly matching first binary cursor', async () => {
  const ring = createPcmRing({ sampleRate: 6400, blockFrames: 64 });
  ring.beginStream({ audioEpoch: audio.audioEpoch, minStartFrame: 0n });
  ring.publish({ startFrame: 0n, frameCount: 64, channels: 2, format: 1,
    payload: Buffer.alloc(64 * 2 * 4) });
  const gateway = createAudioWsGateway({ ring, allowedOrigin: 'http://127.0.0.1:4193',
    getAudioReady: () => audio });
  const server = createCandidateServer({ releaseInfo: {}, audioUpgradeHandler: gateway.handleUpgrade });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/audio`, {
    origin: 'http://127.0.0.1:4193',
  });
  const frames = [];
  await new Promise((resolve, reject) => {
    socket.on('message', (data, binary) => {
      frames.push(binary ? Buffer.from(data) : JSON.parse(data.toString()));
      if (frames.length === 2) resolve();
    });
    socket.on('error', reject);
  });
  assert.equal(frames[0].type, 'audio.ready');
  assert.equal(frames[0].resumeStartFrame, frames[1].readBigUInt64LE(16).toString());
  assert.equal(frames[0].blockSeq, frames[1].readUInt32LE(12));
  socket.close();
  await gateway.close();
  await new Promise((resolve) => server.close(resolve));
});
