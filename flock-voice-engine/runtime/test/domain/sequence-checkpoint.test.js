import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import {
  createSequenceGrid,
  createSequencePatternBridge,
  getSequenceCell,
  setSequenceCell,
} from '../src/sequence.js';

const TREE_IDS = CONFIG.trees.map((tree) => tree.id);
const PITCH_BRANCH_COUNT = CONFIG.tree.branches.length;
const STEP_COUNT = CONFIG.tempo.barsPerDay * CONFIG.tempo.beatsPerBar;
const STATE_KEYS = ['current', 'previous'];

function firstBirdId(treeId) {
  let nextBirdId = 0;
  for (const tree of CONFIG.trees) {
    if (tree.id === treeId) return nextBirdId;
    nextBirdId += tree.birdCount;
  }
  throw new Error(`unknown fixture tree: ${treeId}`);
}

function emptyGrid() {
  return createSequenceGrid({
    treeIds: TREE_IDS,
    pitchBranchCount: PITCH_BRANCH_COUNT,
    stepCount: STEP_COUNT,
  });
}

function eventEntry(treeId, legacyBranchId = 0, cause = 'settle') {
  return {
    birdId: firstBirdId(treeId),
    cause,
    legacyBranchId,
  };
}

function validPair() {
  let current = emptyGrid();
  current = setSequenceCell(
    current,
    { treeId: 'melody', pitchBranchId: 1, stepIndex: 8 },
    [eventEntry('melody', 1, 'sequence')],
  );
  let previous = emptyGrid();
  previous = setSequenceCell(
    previous,
    { treeId: 'pad', pitchBranchId: 2, stepIndex: 4 },
    [eventEntry('pad', 2)],
  );
  return { current, previous };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertInvalidRestoredState(restoredState, label) {
  assert.throws(
    () => createSequencePatternBridge({ config: CONFIG, restoredState }),
    (error) => {
      assert.equal(error?.code, 'INVALID_SEQUENCE_BRIDGE_STATE', label);
      assert.equal(error?.message, 'INVALID_SEQUENCE_BRIDGE_STATE', label);
      return true;
    },
    label,
  );
}

test('两日真实 perch grid 可 JSON round-trip restore，并保持 current/previous 与 clone 隔离', () => {
  const original = createSequencePatternBridge({ config: CONFIG });
  assert.equal(original.feed({
    type: 'perch',
    treeId: 'pad',
    birdId: firstBirdId('pad'),
    branchId: 2,
    phase: 0.25,
    cause: 'settle',
  }), true);
  assert.equal(original.feed({
    event: 'perch',
    treeId: 'pad',
    birdId: firstBirdId('pad') + 1,
    branchId: 2,
    phase: 0.25,
    cause: 'hop',
  }), true);
  const completedDayOne = original.finishDay();
  assert.equal(original.feed({
    type: 'perch',
    treeId: 'melody',
    birdId: firstBirdId('melody'),
    pitchBranchId: 1,
    stepIndex: 8,
    branchId: 1,
    cause: 'sequence',
  }), true);

  const exported = original.exportDeterministicState();
  assert.deepEqual(Object.keys(exported), STATE_KEYS);
  assert.deepEqual(exported.previous, completedDayOne);
  assert.deepEqual(
    JSON.parse(JSON.stringify(exported)),
    exported,
    'export must be strict JSON',
  );

  const restoredInput = JSON.parse(JSON.stringify(exported));
  const restored = createSequencePatternBridge({
    config: CONFIG,
    restoredState: restoredInput,
  });
  assert.deepEqual(restored.getCurrent(), original.getCurrent());
  assert.deepEqual(restored.getPrevious(), original.getPrevious());
  assert.deepEqual(restored.exportDeterministicState(), exported);
  assert.notStrictEqual(restored.getCurrent(), restoredInput.current);
  assert.notStrictEqual(restored.getPrevious(), restoredInput.previous);
  assert.notStrictEqual(
    restored.getCurrent().voices.melody,
    restoredInput.current.voices.melody,
  );

  const currentAddress = {
    treeId: 'melody',
    pitchBranchId: 1,
    stepIndex: 8,
  };
  const expectedCurrentCell = cloneJson(getSequenceCell(restored.getCurrent(), currentAddress));
  restoredInput.current.voices.melody.lanes[1].steps[8] = null;
  assert.deepEqual(
    getSequenceCell(restored.getCurrent(), currentAddress),
    expectedCurrentCell,
    'mutating restore input must not mutate bridge state',
  );

  const firstExport = restored.exportDeterministicState();
  const secondExport = restored.exportDeterministicState();
  assert.notStrictEqual(firstExport, secondExport);
  assert.notStrictEqual(firstExport.current, restored.getCurrent());
  assert.notStrictEqual(firstExport.previous, restored.getPrevious());
  firstExport.current.voices.melody.lanes[1].steps[8] = null;
  assert.deepEqual(secondExport, exported);
  assert.deepEqual(restored.exportDeterministicState(), exported);
});

test('finishDay/getCurrent/getPrevious 的每次状态输出都是独立 clone', () => {
  const bridge = createSequencePatternBridge({ config: CONFIG });
  assert.equal(bridge.feed({
    type: 'perch',
    treeId: 'pad',
    birdId: firstBirdId('pad'),
    branchId: 2,
    phase: 0.25,
    cause: 'settle',
  }), true);
  const completed = bridge.finishDay();
  const expectedPrevious = cloneJson(completed);
  assert.notStrictEqual(completed, bridge.getPrevious());
  completed.voices.pad.lanes[2].steps[4] = null;
  assert.deepEqual(bridge.getPrevious(), expectedPrevious);

  const previousA = bridge.getPrevious();
  const previousB = bridge.getPrevious();
  assert.notStrictEqual(previousA, previousB);
  previousA.voices.pad.lanes[2].steps[4] = null;
  assert.deepEqual(previousB, expectedPrevious);
  assert.deepEqual(bridge.getPrevious(), expectedPrevious);

  assert.equal(bridge.feed({
    type: 'perch',
    treeId: 'melody',
    birdId: firstBirdId('melody'),
    pitchBranchId: 1,
    stepIndex: 8,
    branchId: 1,
    cause: 'sequence',
  }), true);
  const expectedCurrent = cloneJson(bridge.getCurrent());
  const currentA = bridge.getCurrent();
  const currentB = bridge.getCurrent();
  assert.notStrictEqual(currentA, currentB);
  currentA.voices.melody.lanes[1].steps[8] = null;
  assert.deepEqual(currentB, expectedCurrent);
  assert.deepEqual(bridge.getCurrent(), expectedCurrent);
  assert.deepEqual(bridge.exportDeterministicState(), {
    current: expectedCurrent,
    previous: expectedPrevious,
  });
});

test('null restore 路径保持 fresh current 与 previous=null，显式 pair 两键缺一不可', () => {
  const implicitFresh = createSequencePatternBridge({ config: CONFIG });
  const explicitFresh = createSequencePatternBridge({
    config: CONFIG,
    restoredState: null,
  });
  assert.deepEqual(
    explicitFresh.exportDeterministicState(),
    implicitFresh.exportDeterministicState(),
  );
  assert.equal(explicitFresh.getPrevious(), null);

  const freshPair = {
    current: emptyGrid(),
    previous: null,
  };
  const restoredFresh = createSequencePatternBridge({
    config: CONFIG,
    restoredState: freshPair,
  });
  assert.deepEqual(restoredFresh.exportDeterministicState(), freshPair);
  assert.notStrictEqual(restoredFresh.getCurrent(), freshPair.current);

  const pairCases = [
    ['missing current', () => {
      const pair = validPair();
      delete pair.current;
      return pair;
    }],
    ['only current without previous', () => {
      const pair = validPair();
      delete pair.previous;
      return pair;
    }],
    ['extra pair key', () => ({ ...validPair(), extra: true })],
    ['null current', () => ({ ...validPair(), current: null })],
  ];
  for (const [label, factory] of pairCases) {
    assertInvalidRestoredState(factory(), label);
  }
});

test('restore 严格校验 configured grid、tree key set、lane/step 坐标与 cell wire', () => {
  const cases = [
    ['grid missing key', (pair) => {
      delete pair.current.version;
    }],
    ['grid extra key', (pair) => {
      pair.current.extra = true;
    }],
    ['grid version', (pair) => {
      pair.current.version = 1;
    }],
    ['previous grid version', (pair) => {
      pair.previous.version = 1;
    }],
    ['pitch dimension', (pair) => {
      pair.current.pitchBranchCount -= 1;
    }],
    ['step dimension', (pair) => {
      pair.current.stepCount -= 1;
    }],
    ['missing configured tree', (pair) => {
      delete pair.current.voices.texture;
    }],
    ['extra configured tree', (pair) => {
      pair.current.voices.other = cloneJson(pair.current.voices.texture);
    }],
    ['previous wrong tree key set', (pair) => {
      delete pair.previous.voices.bass;
    }],
    ['voice tree id mismatch', (pair) => {
      pair.current.voices.pad.treeId = 'melody';
    }],
    ['voice extra key', (pair) => {
      pair.current.voices.pad.extra = true;
    }],
    ['lane count', (pair) => {
      pair.current.voices.pad.lanes.pop();
    }],
    ['lane coordinate', (pair) => {
      pair.current.voices.pad.lanes[0].pitchBranchId = PITCH_BRANCH_COUNT;
    }],
    ['lane extra key', (pair) => {
      pair.current.voices.pad.lanes[0].extra = true;
    }],
    ['step count', (pair) => {
      pair.current.voices.pad.lanes[0].steps.pop();
    }],
    ['scalar cell', (pair) => {
      pair.current.voices.pad.lanes[0].steps[0] = true;
    }],
    ['empty event cell', (pair) => {
      pair.current.voices.pad.lanes[0].steps[0] = [];
    }],
    ['previous scalar cell', (pair) => {
      pair.previous.voices.pad.lanes[0].steps[0] = true;
    }],
    ['event missing key', (pair) => {
      delete pair.current.voices.melody.lanes[1].steps[8][0].cause;
    }],
    ['event extra key', (pair) => {
      pair.current.voices.melody.lanes[1].steps[8][0].extra = true;
    }],
    ['bird belongs to another tree', (pair) => {
      pair.current.voices.melody.lanes[1].steps[8][0].birdId =
        firstBirdId('pad');
    }],
    ['bird id out of range', (pair) => {
      pair.current.voices.melody.lanes[1].steps[8][0].birdId =
        CONFIG.trees.reduce((total, tree) => total + tree.birdCount, 0);
    }],
    ['event cause', (pair) => {
      pair.current.voices.melody.lanes[1].steps[8][0].cause = 'other';
    }],
    ['legacy branch coordinate', (pair) => {
      pair.current.voices.melody.lanes[1].steps[8][0].legacyBranchId =
        PITCH_BRANCH_COUNT;
    }],
  ];
  for (const [label, mutate] of cases) {
    const pair = cloneJson(validPair());
    mutate(pair);
    assertInvalidRestoredState(pair, label);
  }
});

test('restore 在发布 bridge 前原子拒绝 alias、cycle、accessor 与非 JSON tree', () => {
  const pairAlias = validPair();
  pairAlias.previous = pairAlias.current;
  assertInvalidRestoredState(pairAlias, 'current/previous alias');

  const nestedAlias = validPair();
  nestedAlias.current.voices.pad = nestedAlias.current.voices.melody;
  assertInvalidRestoredState(nestedAlias, 'nested alias');

  const cycle = validPair();
  cycle.current.voices.pad.cycle = cycle;
  assertInvalidRestoredState(cycle, 'cycle');

  let getterCalls = 0;
  const accessor = validPair();
  Object.defineProperty(accessor, 'previous', {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('must not run');
    },
  });
  assertInvalidRestoredState(accessor, 'accessor');
  assert.equal(getterCalls, 0, 'restore validation must not invoke accessors');

  const cases = [
    ['non-enumerable extra', (pair) => {
      Object.defineProperty(pair.current, 'hidden', {
        enumerable: false,
        value: true,
      });
    }],
    ['symbol key', (pair) => {
      pair.current[Symbol('extra')] = true;
    }],
    ['array hole', (pair) => {
      delete pair.current.voices.pad.lanes[0].steps[0];
    }],
    ['array custom key', (pair) => {
      pair.current.voices.pad.lanes[0].steps.extra = true;
    }],
    ['NaN', (pair) => {
      pair.current.voices.pad.lanes[0].steps[0] = Number.NaN;
    }],
    ['negative zero', (pair) => {
      pair.current.voices.pad.lanes[0].steps[0] = -0;
    }],
    ['undefined', (pair) => {
      pair.current.voices.pad.lanes[0].steps[0] = undefined;
    }],
    ['BigInt', (pair) => {
      pair.current.voices.pad.lanes[0].steps[0] = 1n;
    }],
    ['function', (pair) => {
      pair.current.voices.pad.lanes[0].steps[0] = () => {};
    }],
    ['non-plain prototype', (pair) => {
      pair.current.voices.pad = Object.create(
        { inherited: true },
        Object.getOwnPropertyDescriptors(pair.current.voices.pad),
      );
    }],
  ];
  for (const [label, mutate] of cases) {
    const pair = validPair();
    mutate(pair);
    assertInvalidRestoredState(pair, label);
  }

  const { proxy: revoked, revoke } = Proxy.revocable(validPair(), {});
  revoke();
  assertInvalidRestoredState(revoked, 'revoked proxy');
});
