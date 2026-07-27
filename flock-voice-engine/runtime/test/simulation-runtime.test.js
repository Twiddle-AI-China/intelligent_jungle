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
    const beforeInvalid = runtime.exportCheckpoint({
      worldGeneration: 'dt-atomic', revision: 0, eventSeq: 0,
    });
    for (const dt of [
      0, -1, Number.NaN, Number.POSITIVE_INFINITY,
      DT + Number.EPSILON, DT * 2, 32,
    ]) {
      assert.throws(() => runtime.tick(dt), /INVALID_SIMULATION_TICK/);
    }
    assert.deepEqual(runtime.exportCheckpoint({
      worldGeneration: 'dt-atomic', revision: 0, eventSeq: 0,
    }), beforeInvalid);
    const paused = runtime.applyCommand({ name: 'runtime.pause', payload: {} });
    assert.deepEqual(paused.commandResult, { accepted: true, code: 'OK', paused: true });
    assert.equal(paused.changed, true);
    assert.deepEqual(paused.domainEvents, []);
    assert.deepEqual(paused.audioCommands, []);
    const pausedBeforeInvalid = runtime.exportCheckpoint({
      worldGeneration: 'dt-paused', revision: 1, eventSeq: 1,
    });
    assert.throws(() => runtime.tick(DT + Number.EPSILON), /INVALID_SIMULATION_TICK/);
    assert.deepEqual(runtime.exportCheckpoint({
      worldGeneration: 'dt-paused', revision: 1, eventSeq: 1,
    }), pausedBeforeInvalid);
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

test('command payload 拒绝 Proxy/accessor 且不在校验后重读 caller', () => {
  const runtime = createSimulationRuntime({ seed: SEED });
  try {
    let getCount = 0;
    const proxied = new Proxy({
      treeId: 'melody', pitchBranchId: 0, stepIndex: 0, stepCount: 16,
    }, {
      get(target, key, receiver) {
        getCount += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const proxyDraft = runtime.applyCommand({ name: 'sequence.place', payload: proxied });
    assert.deepEqual(proxyDraft.commandResult, {
      accepted: false,
      code: 'INVALID_COMMAND_PAYLOAD',
    });
    assert.equal(getCount, 0);

    let accessorCount = 0;
    const accessor = { birdId: 0 };
    Object.defineProperty(accessor, 'birdId', {
      enumerable: true,
      get() {
        accessorCount += 1;
        return 0;
      },
    });
    assert.equal(runtime.applyCommand({
      name: 'bird.shoo', payload: accessor,
    }).commandResult.code, 'INVALID_COMMAND_PAYLOAD');
    assert.equal(accessorCount, 0);

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    assert.equal(runtime.applyCommand({
      name: 'runtime.pause', payload: proxy,
    }).commandResult.code, 'INVALID_COMMAND_PAYLOAD');
  } finally {
    runtime.dispose();
  }
});

test('七个 Phase 2 command 的成功、NO_CHANGE、DOMAIN_REJECTED 边界固定', () => {
  const runtime = createSimulationRuntime({ seed: SEED });
  try {
    assert.deepEqual(runtime.applyCommand({
      name: 'runtime.pause', payload: {},
    }).commandResult, { accepted: true, code: 'OK', paused: true });
    assert.deepEqual(runtime.applyCommand({
      name: 'runtime.pause', payload: {},
    }).commandResult, { accepted: true, code: 'NO_CHANGE', paused: true });
    assert.deepEqual(runtime.applyCommand({
      name: 'runtime.resume', payload: {},
    }).commandResult, { accepted: true, code: 'OK', paused: false });

    assert.deepEqual(runtime.applyCommand({
      name: 'sequence.toggle',
      payload: { treeId: 'melody', pitchBranchId: 0, stepIndex: 0 },
    }).commandResult, { accepted: false, code: 'DOMAIN_REJECTED' });
    const placed = runtime.applyCommand({
      name: 'sequence.place',
      payload: { treeId: 'melody', pitchBranchId: 2, stepIndex: 3, stepCount: 16 },
    });
    assert.deepEqual(placed.commandResult, {
      accepted: true,
      code: 'OK',
      placement: {
        birdId: 5, branchId: 2, replaced: false, same: false, evictedId: null,
      },
    });
    assert.deepEqual(runtime.applyCommand({
      name: 'bird.shoo', payload: { birdId: 99 },
    }).commandResult, { accepted: false, code: 'DOMAIN_REJECTED' });
    assert.deepEqual(runtime.applyCommand({
      name: 'bird.shoo', payload: { birdId: 5 },
    }).commandResult, { accepted: true, code: 'OK', birdId: 5 });
    assert.deepEqual(runtime.applyCommand({
      name: 'transport.setTempo', payload: { bpm: 60 },
    }).commandResult, { accepted: true, code: 'NO_CHANGE', bpm: 60 });
    assert.deepEqual(runtime.applyCommand({
      name: 'transport.setTempo', payload: { bpm: 90 },
    }).commandResult, { accepted: true, code: 'OK', bpm: 90 });
    assert.deepEqual(runtime.applyCommand({
      name: 'transport.setMeter', payload: { beatsPerBar: 4 },
    }).commandResult, {
      accepted: true, code: 'NO_CHANGE', beatsPerBar: 4, barsPerDay: 4,
    });
    assert.deepEqual(runtime.applyCommand({
      name: 'transport.setMeter', payload: { beatsPerBar: 2 },
    }).commandResult, {
      accepted: true, code: 'OK', beatsPerBar: 2, barsPerDay: 8,
    });
  } finally {
    runtime.dispose();
  }

  const checkpointSource = createSimulationRuntime({ seed: SEED });
  const userCheckpoint = structuredClone(checkpointSource.exportCheckpoint({
    worldGeneration: 'user-fixture', revision: 0, eventSeq: 0,
  }));
  checkpointSource.dispose();
  userCheckpoint.control.treeControl.melody = 'USER';
  const userRuntime = createSimulationRuntime({ seed: SEED, restoredSnapshot: userCheckpoint });
  try {
    assert.deepEqual(userRuntime.applyCommand({
      name: 'sequence.toggle',
      payload: { treeId: 'melody', pitchBranchId: 0, stepIndex: 0 },
    }).commandResult, {
      accepted: true,
      code: 'OK',
      treeId: 'melody',
      pitchBranchId: 0,
      stepIndex: 0,
      active: true,
    });
  } finally {
    userRuntime.dispose();
  }
});

test('perch/unperch 诊断保持 domain event 相对顺序且 NullAudioSink 不产 PCM', () => {
  const acceptedBatches = [];
  const nullSink = createNullAudioSink();
  const sink = {
    accept(commands) {
      assert.equal(Object.isFrozen(commands), true);
      acceptedBatches.push(commands);
      nullSink.accept(commands);
    },
  };
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
    assert.deepEqual(placement.domainEvents, [{
      name: 'perch',
      payload: {
        birdId: 5,
        treeId: 'melody',
        branchId: 2,
        cause: 'user',
        returnedToLastBranch: false,
        perchedOnBranch: 1,
        perchedOnTree: 1,
        phase: 0.08,
        day: 1,
        time: 0,
        pitchBranchId: 2,
        stepIndex: 3,
        stepCount: 16,
        jungleEditPlan: null,
      },
    }]);
    assert.deepEqual(placement.audioCommands, [{
      type: 'note.on', treeId: 'melody', birdId: 5, midi: 76, velocity: 0.42,
    }]);
    assert.strictEqual(acceptedBatches[0], placement.audioCommands);
    const shoo = runtime.applyCommand({
      name: 'bird.shoo',
      payload: { birdId: placement.commandResult.placement.birdId },
    });
    assert.equal(shoo.commandResult.accepted, true);
    assert.deepEqual(shoo.domainEvents, [{
      name: 'unperch',
      payload: {
        birdId: 5,
        treeId: 'melody',
        branchId: 2,
        cause: 'user',
        dwellTime: 0,
        dwellBeats: 0,
        phase: 0.08,
        day: 1,
        time: 0,
      },
    }]);
    assert.deepEqual(shoo.audioCommands, [{
      type: 'note.release',
      treeId: 'melody',
      birdId: 5,
      midi: 76,
      durationSeconds: 0,
    }]);
    assert.strictEqual(acceptedBatches[1], shoo.audioCommands);
    const empty = runtime.applyCommand({ name: 'runtime.pause', payload: {} });
    assert.deepEqual(empty.domainEvents, []);
    assert.deepEqual(empty.audioCommands, []);
    assert.equal(acceptedBatches.length, 2);
    assert.deepEqual(nullSink.getStatus(), {
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

test('九类 collector 全部可达，audio 始终是 perch/unperch 的有序子序列', () => {
  const runtime = createSimulationRuntime({ seed: SEED });
  const operations = [
    runtime.applyCommand({
      name: 'sequence.place',
      payload: {
        treeId: 'melody', pitchBranchId: 2, stepIndex: 3, stepCount: 16,
      },
    }),
    runtime.applyCommand({ name: 'transport.setMeter', payload: { beatsPerBar: 2 } }),
  ];
  try {
    for (let index = 0; index < 4_000; index += 1) operations.push(runtime.tick(DT));
  } finally {
    runtime.dispose();
  }

  const checkpointSource = createSimulationRuntime({ seed: SEED });
  const resumeCheckpoint = structuredClone(checkpointSource.exportCheckpoint({
    worldGeneration: 'resume-fixture', revision: 0, eventSeq: 0,
  }));
  checkpointSource.dispose();
  resumeCheckpoint.control.agentResumeAt.melody = DT / 2;
  const restored = createSimulationRuntime({ seed: SEED, restoredSnapshot: resumeCheckpoint });
  try {
    operations.push(restored.tick(DT));
  } finally {
    restored.dispose();
  }

  const firstByName = new Map();
  for (const operation of operations) {
    for (const event of operation.domainEvents) {
      if (!firstByName.has(event.name)) firstByName.set(event.name, event);
    }
    assert.deepEqual(
      operation.audioCommands.map(({ type, treeId, birdId }) => ({ type, treeId, birdId })),
      operation.domainEvents
        .filter(({ name }) => name === 'perch' || name === 'unperch')
        .map(({ name, payload }) => ({
          type: name === 'perch' ? 'note.on' : 'note.release',
          treeId: payload.treeId,
          birdId: payload.birdId,
        })),
    );
  }
  assert.deepEqual([...firstByName.keys()].sort(), [
    'agent-resume', 'dawn', 'dusk', 'meter-change', 'perch', 'season-migration',
    'sequence-pattern', 'sequence-step', 'unperch',
  ]);
  const expectedPayloadKeys = {
    'agent-resume': ['day', 'phase', 'scheduledAt', 'time', 'treeId'],
    dawn: ['day', 'phase', 'stats', 'time'],
    dusk: ['day', 'phase', 'time'],
    'meter-change': ['barsPerDay', 'beatsPerBar', 'time'],
    perch: [
      'birdId', 'branchId', 'cause', 'day', 'jungleEditPlan', 'perchedOnBranch',
      'perchedOnTree', 'phase', 'pitchBranchId', 'returnedToLastBranch', 'stepCount',
      'stepIndex', 'time', 'treeId',
    ],
    'season-migration': ['day', 'moves'],
    'sequence-pattern': ['cause', 'pattern', 'treeId'],
    'sequence-step': ['day', 'phase', 'stepCount', 'stepIndex', 'time', 'treeId', 'triggered'],
    unperch: [
      'birdId', 'branchId', 'cause', 'day', 'dwellBeats', 'dwellTime', 'phase', 'time',
      'treeId',
    ],
  };
  for (const [name, keys] of Object.entries(expectedPayloadKeys)) {
    assert.deepEqual(Object.keys(firstByName.get(name).payload).sort(), [...keys].sort(), name);
  }
});
