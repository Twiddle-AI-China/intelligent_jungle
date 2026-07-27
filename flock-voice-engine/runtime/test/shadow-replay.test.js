import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createShadowOracle } from '../../../mvp/eval/shadow-oracle.js';
import {
  compareShadowValue,
  SHADOW_TOLERANCES,
} from '../src/shadow/compare.js';
import {
  assertShadowMatch,
  createShadowRunner,
} from '../src/shadow/shadow-runner.js';

const cases = JSON.parse(await readFile(
  new URL('./fixtures/phase2-shadow-cases.json', import.meta.url),
  'utf8',
));

test('five deterministic shadow cases match every logical operation', async () => {
  const { runShadowCase } = createShadowRunner({ createOracle: createShadowOracle });
  assert.equal(cases.length, 5);
  for (const testCase of cases) {
    const result = await runShadowCase(testCase);
    assertShadowMatch(result);
    assert.equal(result.matched, true, testCase.name);
    assert.equal(result.comparedTicks, testCase.ticks, testCase.name);
    assert.equal(result.comparedBatches, testCase.expectedBatches, testCase.name);
  }
});

test('comparator reports the first exact difference with operation context', () => {
  const baseContext = {
    tick: 7,
    operationIndex: 9,
    eventIndex: null,
    recentExpectedEvents: [{ name: 'dusk', payload: { day: 1 } }],
    recentActualEvents: [{ name: 'dusk', payload: { day: 1 } }],
    expectedRng: { world: { state: 1, drawCount: 2 } },
    actualRng: { world: { state: 1, drawCount: 2 } },
  };
  for (const [kind, expected, actual, path] of [
    ['envelope', { revision: 1 }, { revision: 2 }, '$.revision'],
    ['commandResult', { accepted: true }, { accepted: false }, '$.accepted'],
    ['audioCommands', [{ type: 'note.on' }], [{ type: 'note.release' }], '$[0].type'],
    ['snapshot', { day: 1 }, { day: 2 }, '$.day'],
    ['events', [{ name: 'dawn' }], [{ name: 'dusk' }], '$[0].name'],
    ['rng', { state: 1, drawCount: 2 }, { state: 1, drawCount: 3 }, '$.drawCount'],
    ['checkpoint', { revision: 1 }, { revision: 2 }, '$.revision'],
  ]) {
    const difference = compareShadowValue(expected, actual, { ...baseContext, kind });
    assert.equal(difference.kind, kind);
    assert.equal(difference.path, path);
    assert.equal(difference.tick, 7);
    assert.equal(difference.operationIndex, 9);
    assert.deepEqual(difference.expectedRng, baseContext.expectedRng);
    if (kind === 'events') assert.equal(difference.eventIndex, 0);
  }
});

test('ordered corruption reports the first audio/event position, not only final state', () => {
  const context = { tick: 4, operationIndex: 6 };
  const audio = compareShadowValue(
    [{ type: 'note.release', birdId: 5 }, { type: 'note.on', birdId: 6 }],
    [{ type: 'note.on', birdId: 6 }, { type: 'note.release', birdId: 5 }],
    { ...context, kind: 'audioCommands' },
  );
  assert.equal(audio.path, '$[0].birdId');
  const events = compareShadowValue(
    [{ name: 'unperch', payload: { birdId: 5 } }, { name: 'perch', payload: { birdId: 6 } }],
    [{ name: 'perch', payload: { birdId: 6 } }, { name: 'unperch', payload: { birdId: 5 } }],
    { ...context, kind: 'events' },
  );
  assert.equal(events.path, '$[0].name');
  assert.equal(events.eventIndex, 0);
});

test('snapshot tolerance is whitelisted; NaN never compares equal', () => {
  assert.equal(compareShadowValue(
    { simTime: 1 },
    { simTime: 1 + SHADOW_TOLERANCES['$.simTime'] / 2 },
    { kind: 'snapshot', tick: 0, operationIndex: 0 },
  ), null);
  assert.equal(compareShadowValue(
    { day: 1 }, { day: 1 + Number.EPSILON },
    { kind: 'snapshot', tick: 0, operationIndex: 0 },
  ).path, '$.day');
  assert.equal(compareShadowValue(
    { simTime: Number.NaN }, { simTime: Number.NaN },
    { kind: 'snapshot', tick: 0, operationIndex: 0 },
  ).path, '$.simTime');
  for (const [expected, actual] of [[-0, 0], [0, -0]]) {
    assert.equal(compareShadowValue(
      { simTime: expected }, { simTime: actual },
      { kind: 'snapshot', tick: 0, operationIndex: 0 },
    ).path, '$.simTime');
  }
});

test('runner reports real draft and frame corruption at the first operation', async () => {
  const probe = {
    ...cases[2],
    name: 'runner corruption probe',
    ticks: 1,
    commands: [cases[2].commands[0]],
    checkpointAt: null,
    compareFinalCheckpoint: false,
    requiredAcceptedCommands: [],
  };
  const corruptions = [
    ['envelope', '$.seed', (draft) => { draft.snapshot.seed += 1; }],
    ['commandResult', '$.code', (draft) => { draft.commandResult.code = 'CORRUPTED'; }],
    ['audioCommands', '$[0].type', (draft) => { draft.audioCommands[0].type = 'corrupt'; }],
    ['snapshot', '$.day', (draft) => { draft.snapshot.day += 1; }],
    ['events', '$[0].name', (draft) => { draft.domainEvents[0].name = 'corrupt'; }],
  ];
  for (const [kind, path, mutate] of corruptions) {
    const runner = createShadowRunner({
      createOracle: createShadowOracle,
      transformCandidateDraft(draft, context) {
        if (context.operationIndex !== 0) return draft;
        const corrupted = structuredClone(draft);
        mutate(corrupted);
        return corrupted;
      },
    });
    const shadowResult = await runner.runShadowCase(probe);
    assert.equal(shadowResult.matched, false, kind);
    assert.equal(shadowResult.firstDifference.kind, kind);
    assert.equal(shadowResult.firstDifference.path, path);
    assert.equal(shadowResult.firstDifference.tick, 0);
    assert.equal(shadowResult.firstDifference.operationIndex, 0);
    if (kind === 'events') assert.equal(shadowResult.firstDifference.eventIndex, 0);
  }

  const framed = createShadowRunner({
    createOracle: createShadowOracle,
    transformCandidateFrames(frames, context) {
      if (context.operationIndex !== 0) return frames;
      const corrupted = structuredClone(frames);
      corrupted[1].eventIndex = 9;
      return corrupted;
    },
  });
  const frameResult = await framed.runShadowCase(probe);
  assert.equal(frameResult.matched, false);
  assert.equal(frameResult.firstDifference.kind, 'envelope');
  assert.equal(frameResult.firstDifference.path, '$[1].eventIndex');
  assert.equal(frameResult.firstDifference.operationIndex, 0);

  const patchPayload = createShadowRunner({
    createOracle: createShadowOracle,
    transformCandidateFrames(frames, context) {
      if (context.operationIndex !== 0) return frames;
      const corrupted = structuredClone(frames);
      corrupted[0].patch[0].value.day += 1;
      return corrupted;
    },
  });
  const patchResult = await patchPayload.runShadowCase(probe);
  assert.equal(patchResult.matched, false);
  assert.equal(patchResult.firstDifference.kind, 'snapshot');
  assert.equal(patchResult.firstDifference.path, '$.day');

  const unchangedEnvelope = createShadowRunner({
    createOracle: createShadowOracle,
    transformCandidateDraft(draft, context) {
      if (context.operationIndex !== 1) return draft;
      const corrupted = structuredClone(draft);
      corrupted.snapshot.seed = 999999;
      return corrupted;
    },
  });
  const unchangedResult = await unchangedEnvelope.runShadowCase({
    ...cases[0],
    ticks: 1,
    commands: [
      { atTick: 0, name: 'runtime.pause', payload: {} },
      { atTick: 0, name: 'runtime.pause', payload: {} },
    ],
    compareFinalCheckpoint: false,
    elapsedReference: null,
  });
  assert.equal(unchangedResult.matched, false);
  assert.equal(unchangedResult.firstDifference.kind, 'envelope');
  assert.equal(unchangedResult.firstDifference.path, '$.seed');
  assert.equal(unchangedResult.firstDifference.operationIndex, 1);
});

test('runner reports RNG and explicit-checkpoint corruption through export seams', async () => {
  let rngExports = 0;
  const rngRunner = createShadowRunner({
    createOracle: createShadowOracle,
    transformCandidateCheckpoint(checkpoint) {
      const corrupted = structuredClone(checkpoint);
      if (rngExports >= 2) corrupted.rng.world.state += 1;
      rngExports += 1;
      return corrupted;
    },
  });
  const rngResult = await rngRunner.runShadowCase({
    ...cases[0], ticks: 1, compareFinalCheckpoint: false, elapsedReference: null,
  });
  assert.equal(rngResult.matched, false);
  assert.equal(rngResult.firstDifference.kind, 'rng');
  assert.equal(rngResult.firstDifference.tick, 0);
  assert.equal(rngResult.firstDifference.operationIndex, 0);

  let checkpointExports = 0;
  const checkpointRunner = createShadowRunner({
    createOracle: createShadowOracle,
    transformCandidateCheckpoint(checkpoint) {
      const corrupted = structuredClone(checkpoint);
      if (checkpointExports >= 6) corrupted.control.paused = true;
      checkpointExports += 1;
      return corrupted;
    },
  });
  const checkpointResult = await checkpointRunner.runShadowCase({
    ...cases[0], ticks: 1, checkpointAt: 1, compareFinalCheckpoint: false,
    elapsedReference: null,
  });
  assert.equal(checkpointResult.matched, false);
  assert.equal(checkpointResult.firstDifference.kind, 'checkpoint');
  assert.equal(checkpointResult.firstDifference.path, '$.control.paused');
  assert.equal(checkpointResult.firstDifference.tick, 1);
  assert.equal(checkpointResult.firstDifference.operationIndex, 1);
});

test('oracle and candidate atomically reject DT + epsilon before state/events/RNG', async () => {
  const { runShadowCase } = createShadowRunner({ createOracle: createShadowOracle });
  const result = await runShadowCase({
    ...cases[0],
    name: 'invalid dt probe',
    ticks: 0,
    expectedBatches: 0,
    invalidDt: (1 / 30) + Number.EPSILON,
    compareFinalCheckpoint: false,
  });
  assertShadowMatch(result);
  assert.equal(result.matched, true);
});

test('every tolerance pattern matches a committed bootstrap snapshot path', async () => {
  const oracle = createShadowOracle({ seed: cases[0].seed });
  try {
    const paths = new Set();
    function collect(value, path = '$') {
      if (value === null || typeof value !== 'object') {
        paths.add(path.replace(/\[\d+\]/g, '[*]'));
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((child, index) => collect(child, `${path}[${index}]`));
        return;
      }
      for (const [key, child] of Object.entries(value)) collect(child, `${path}.${key}`);
    }
    collect(oracle.getSnapshot());
    for (const pattern of Object.keys(SHADOW_TOLERANCES)) {
      assert.equal(paths.has(pattern), true, pattern);
    }
  } finally {
    oracle.dispose();
  }
});
