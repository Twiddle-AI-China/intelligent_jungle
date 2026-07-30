import assert from 'node:assert/strict';
import test from 'node:test';

import { createPhase5ClientActuator } from '../../src/acceptance/phase5-client-actuator.js';

function claim(socketKind, generation = 1) {
  return Object.freeze({
    runId: '123e4567-e89b-42d3-a456-426614174000',
    client: 4,
    clientIdentitySha256: '4'.repeat(64),
    socketKind,
    generation,
  });
}

test('client actuator owns exact disconnect and capacity plus one pressure', () => {
  const closes = [];
  const frames = [];
  const actuator = createPhase5ClientActuator({
    recorder: { audioPause() {}, audioResume() {} },
  });
  actuator.registerRuntime(claim('runtime'), {
    close: (...args) => closes.push(args),
    enqueue(frame) {
      frames.push(frame);
      return frames.length <= 256;
    },
  });
  actuator.disconnectRuntime();
  actuator.saturateEgress();
  assert.deepEqual(closes, [[1000, 'PHASE5_RUNTIME_RECONNECT']]);
  assert.equal(frames.length, 257);
  assert.deepEqual(frames[0], {
    type: 'phase5.queue-pressure', protocolVersion: 1, sequence: 1,
  });
});

test('reconnect grants are one-shot and audio completion becomes server evidence', async () => {
  const audio = [];
  const actuator = createPhase5ClientActuator({
    recorder: {
      audioPause: (value) => audio.push(['pause', value.generation]),
      audioResume: (value) => audio.push(['resume', value.generation]),
    },
  });
  actuator.acceptReconnectGrant({
    runId: '123e4567-e89b-42d3-a456-426614174000',
    client: 4,
    clientIdentitySha256: '4'.repeat(64),
    socketKind: 'runtime', generation: 2,
    capability: 'a'.repeat(43),
  });
  assert.equal((await actuator.waitRuntimeReconnectGrant()).generation, 2);

  const audioActuator = createPhase5ClientActuator({
    recorder: {
      audioPause: (value) => audio.push(['pause', value.generation]),
      audioResume: (value) => audio.push(['resume', value.generation]),
    },
  });
  audioActuator.registerAudio(claim('audio', 3));
  audioActuator.recordAudioCompletion(5);
  audioActuator.recordAudioCompletion(6);
  assert.deepEqual(audio, [['pause', 3], ['resume', 3]]);
});
