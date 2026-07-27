import assert from 'node:assert/strict';
import test from 'node:test';

import { DOMAIN_CONFIG } from '../src/domain/config.js';
import { createNullAudioSink } from '../src/audio/null-audio-sink.js';
import {
  createSimulationKernelFactory,
  createSimulationRuntime,
} from '../src/simulation-runtime.js';

const SEED = 0x4c4353;
const DT = 1 / DOMAIN_CONFIG.sim.tickHz;

function assertDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test('tick 固定步长域、pause/resume 与完整 draft 契约', () => {
  const runtime = createSimulationRuntime({ seed: SEED });
  try {
    for (const dt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, DT + Number.EPSILON]) {
      assert.throws(() => runtime.tick(dt), /INVALID_SIMULATION_TICK/);
    }
    const paused = runtime.applyCommand({ name: 'runtime.pause', payload: {} });
    assert.deepEqual(paused.commandResult, { accepted: true, code: 'OK', paused: true });
    assert.equal(paused.changed, true);
    assert.deepEqual(paused.domainEvents, []);
    assert.deepEqual(paused.audioCommands, []);
    const pausedTick = runtime.tick(DT);
    assert.equal(pausedTick.changed, false);
    assert.equal(pausedTick.snapshot.paused, true);
    const resumed = runtime.applyCommand({ name: 'runtime.resume', payload: {} });
    assert.deepEqual(resumed.commandResult, { accepted: true, code: 'OK', paused: false });
    const ticked = runtime.tick(DT / 2);
    assert.equal(ticked.changed, true);
    assert.equal(ticked.snapshot.paused, false);
    assert.equal(typeof ticked.snapshot.season, 'string');
    assert.equal(Object.hasOwn(ticked, 'commandResult'), false);
    assertDeepFrozen(ticked);
  } finally {
    runtime.dispose();
  }
});

test('command payload 严格校验并冻结 Phase 2 拒绝语义', () => {
  const runtime = createSimulationRuntime({ seed: SEED });
  try {
    for (const command of [
      { name: 'runtime.pause', payload: { extra: true } },
      { name: 'sequence.place', payload: { treeId: 'pad', pitchBranchId: 0, stepIndex: 0 } },
      { name: 'bird.shoo', payload: { birdId: -1 } },
      { name: 'transport.setMeter', payload: { beatsPerBar: 3 } },
    ]) {
      const draft = runtime.applyCommand(command);
      assert.deepEqual(draft.commandResult, {
        accepted: false,
        code: 'INVALID_COMMAND_PAYLOAD',
      });
      assert.equal(draft.changed, false);
    }
    assert.equal(runtime.applyCommand({
      name: 'snapshot.request', payload: {},
    }).commandResult.code, 'GATEWAY_ONLY_COMMAND');
    assert.equal(runtime.applyCommand({
      name: 'control.take', payload: {},
    }).commandResult.code, 'UNAVAILABLE_IN_PHASE_2');
    assert.equal(runtime.applyCommand({
      name: 'not.real', payload: {},
    }).commandResult.code, 'UNKNOWN_COMMAND');
  } finally {
    runtime.dispose();
  }
});

test('perch/unperch 诊断保持 domain event 相对顺序且 NullAudioSink 不产 PCM', () => {
  const sink = createNullAudioSink();
  const runtime = createSimulationRuntime({ seed: SEED, audioSink: sink });
  try {
    const placement = runtime.applyCommand({
      name: 'sequence.place',
      payload: {
        treeId: 'melody', pitchBranchId: 2, stepIndex: 3, stepCount: 16,
      },
    });
    assert.equal(placement.commandResult.accepted, true);
    assert.equal(placement.commandResult.placement.branchId, 2);
    assert.ok(placement.domainEvents.some(({ name }) => name === 'perch'));
    assert.equal(placement.audioCommands.length, placement.domainEvents.filter(
      ({ name }) => name === 'perch' || name === 'unperch',
    ).length);
    const shoo = runtime.applyCommand({
      name: 'bird.shoo',
      payload: { birdId: placement.commandResult.placement.birdId },
    });
    assert.equal(shoo.commandResult.accepted, true);
    assert.deepEqual(shoo.domainEvents.map(({ name }) => name), ['unperch']);
    assert.deepEqual(shoo.audioCommands.map(({ type }) => type), ['note.release']);
    assert.deepEqual(sink.getStatus(), {
      mode: 'null',
      acceptedCommandCount: placement.audioCommands.length + shoo.audioCommands.length,
      pcmFrameCount: 0,
    });
  } finally {
    assert.equal(runtime.dispose(), true);
    assert.equal(runtime.dispose(), false);
  }
});

test('kernel factory 每个 owner 独立 config 与 sink', () => {
  let sinkCount = 0;
  const createKernel = createSimulationKernelFactory({
    createAudioSink() {
      sinkCount += 1;
      return createNullAudioSink();
    },
  });
  const first = createKernel({ seed: SEED });
  const second = createKernel({ seed: SEED });
  try {
    const firstMeter = first.applyCommand({
      name: 'transport.setMeter', payload: { beatsPerBar: 2 },
    });
    const secondMeter = second.applyCommand({
      name: 'transport.setMeter', payload: { beatsPerBar: 4 },
    });
    assert.equal(firstMeter.commandResult.beatsPerBar, 2);
    assert.equal(firstMeter.commandResult.barsPerDay, 8);
    assert.equal(secondMeter.commandResult.code, 'NO_CHANGE');
    assert.equal(secondMeter.commandResult.beatsPerBar, DOMAIN_CONFIG.tempo.beatsPerBar);
    assert.equal(sinkCount, 2);
  } finally {
    first.dispose();
    second.dispose();
  }
});
