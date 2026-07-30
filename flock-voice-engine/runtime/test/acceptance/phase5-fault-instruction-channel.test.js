import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  decodePhase5FaultControlInstruction,
  encodePhase5FaultControlCompletion,
} from '../../src/acceptance/phase5-fault-control-protocol.js';
import {
  createPhase5FaultInstructionChannel,
} from '../../src/acceptance/phase5-fault-instruction-channel.js';

function fixture() {
  const local = [];
  const audio = [];
  const frames = [];
  const channel = createPhase5FaultInstructionChannel({
    clientActuator: {
      disconnectRuntime: () => local.push(3),
      saturateEgress: () => local.push(7),
      waitRuntimeReconnectGrant: async () => ({
        capability: 'a'.repeat(43),
      }),
      recordAudioCompletion: (sequence) => audio.push(sequence),
    },
  });
  channel.bindTransport((bytes) => frames.push(bytes));
  return { channel, local, audio, frames };
}

function instruction(sequence) {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'phase5-fixed-instruction',
    sequence,
    plannedAudioEpoch: sequence === 13 ? `phase5-${'f'.repeat(32)}` : null,
  });
}

test('local actions never leave the candidate runtime', async () => {
  const { channel, local, frames } = fixture();
  const signed = Buffer.from('signed-1');
  const first = channel.instructionSink.dispatch(instruction(1), signed);
  await new Promise((resolve) => queueMicrotask(resolve));
  channel.acceptCompletion(encodePhase5FaultControlCompletion({
    schemaVersion: 1,
    kind: 'phase5-fixed-instruction-complete',
    sequence: 1,
    actionEventSha256: createHash('sha256').update(signed).digest('hex'),
    accepted: true,
  }));
  await first;
  await channel.instructionSink.dispatch(
    instruction(3), Buffer.from('signed-3'));
  assert.deepEqual(local, [3]);
  assert.equal(frames.length, 1);
});

test('relay completion is bound to the exact signed action digest', async () => {
  const { channel, frames, audio } = fixture();
  const signed = Buffer.from('signed-action-one');
  const pending = channel.instructionSink.dispatch(instruction(1), signed);
  await new Promise((resolve) => queueMicrotask(resolve));
  const outbound = decodePhase5FaultControlInstruction(frames[0]);
  assert.equal(outbound.runtimeCapability, null);
  const digest = createHash('sha256').update(signed).digest('hex');
  channel.acceptCompletion(encodePhase5FaultControlCompletion({
    schemaVersion: 1,
    kind: 'phase5-fixed-instruction-complete',
    sequence: 1,
    actionEventSha256: digest,
    accepted: true,
  }));
  await pending;
  assert.deepEqual(audio, []);
});
