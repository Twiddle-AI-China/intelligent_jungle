import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import {
  createDeterministicRng,
  deriveConductorSeed,
} from '../src/deterministic-rng.js';
import {
  chordFromFrame,
  colorOptions,
  skeletonForSeason,
} from '../src/harmony.js';
import { createSequenceGrid } from '../src/sequence.js';
import {
  createSimulationCheckpoint,
  SIMULATION_CHECKPOINT_SCHEMA_VERSION,
  SIMULATION_CONFIG_REVISION,
  validateSimulationCheckpoint,
} from '../src/simulation-checkpoint.js';
import { daylightFromPhase } from '../src/world.js';

const ROOT_SEED = 7;
const TREE_IDS = CONFIG.trees.map((tree) => tree.id);
const BRANCH_COUNT = CONFIG.tree.branches.length;
const STEP_COUNT = CONFIG.tempo.barsPerDay * CONFIG.tempo.beatsPerBar;
const TOP_LEVEL_KEYS = [
  'worldId',
  'protocolVersion',
  'snapshotSchemaVersion',
  'schemaVersion',
  'configRevision',
  'worldGeneration',
  'seed',
  'revision',
  'eventSeq',
  'world',
  'sequence',
  'conductor',
  'rng',
  'control',
];
const CONTROL_KEYS = [
  'treeControl',
  'agentResumeAt',
  'tempo',
  'masterControl',
  'pendingUserSeasonLength',
  'paused',
];

function mapTrees(factory) {
  return Object.fromEntries(CONFIG.trees.map((tree, index) => [
    tree.id,
    factory(tree, index),
  ]));
}

function emptyGrid() {
  return createSequenceGrid({
    treeIds: TREE_IDS,
    pitchBranchCount: BRANCH_COUNT,
    stepCount: STEP_COUNT,
  });
}

function emptySummary(cells = []) {
  return {
    version: 2,
    pitchBranchCount: BRANCH_COUNT,
    stepCount: STEP_COUNT,
    occupiedCells: cells,
  };
}

function variableWorldSummary(pitchBranchCount, stepCount, occupiedCells = []) {
  return {
    version: 2,
    pitchBranchCount,
    stepCount,
    occupiedCells,
  };
}

function makeFrame() {
  const season = CONFIG.harmony.seasons[0];
  const progressionId = CONFIG.harmony.bySeason[season].progressions[0].id;
  return {
    season,
    seasonDay: 0,
    seasonLength: CONFIG.harmony.defaultSeasonLength,
    progressionStep: 0,
    progressionCycle: 0,
    progressionId,
    period: 'day',
    skeleton: skeletonForSeason(season, CONFIG.harmony, 0, progressionId),
    color: colorOptions(season, CONFIG.harmony, 0, 'day', progressionId)[0],
    tension: CONFIG.harmony.tensionRange[0],
  };
}

function makeBird(tree, id) {
  const allowedBranches = CONFIG.species[tree.species].allowedBranches
    ?? CONFIG.tree.branches.map((branch) => branch.id);
  return {
    id,
    treeId: tree.id,
    state: 'flying',
    branchId: null,
    slotIndex: null,
    homeBranch: allowedBranches[0],
    activeToday: false,
    mode: 'free',
    targetBranch: null,
    settleAt: 0,
    plannedDwell: null,
    plannedFlight: null,
    switchesUsed: 0,
    lastBranch: null,
    returnBranch: null,
    returnCause: null,
    returnSequence: 0,
    visitCounts: new Array(BRANCH_COUNT).fill(0),
    energy: 0.5,
    dwellTime: 0,
    dwellBeatTime: 0,
    flightTime: 0,
    orbitRadius: CONFIG.birds.orbitRadiusMin,
    orbitAngle: 0,
    orbitSpeed: CONFIG.birds.orbitAngularSpeed,
    bobPhase: 0,
    sequenceAddress: null,
    pos: { x: tree.xOffset, y: 0 },
  };
}

function makeWorldState() {
  let nextBirdId = 0;
  return {
    world: {
      clock: {
        simTime: 0,
        day: 1,
        phase: CONFIG.sim.startPhase,
        bpm: CONFIG.tempo.defaultBpm,
        dayLength: CONFIG.tempo.barsPerDay
          * CONFIG.tempo.beatsPerBar
          * 60
          / CONFIG.tempo.defaultBpm,
        daylight: daylightFromPhase(CONFIG.sim.startPhase),
      },
      trees: CONFIG.trees.map((tree) => ({
        id: tree.id,
        densityTier: CONFIG.agent.defaultDensityTier,
        dwellBeats: CONFIG.species[tree.species].dwellBeats,
        activeBars: CONFIG.tempo.barsPerDay,
        lastSeasonMigrationDay: null,
        stats: {
          switches: 0,
          perBirdSwitches: {},
          dwellSamples: [],
          dwellBeatSamples: [],
          silentTime: 0,
          dayTime: 0,
        },
        branchPreference: new Array(BRANCH_COUNT).fill(1),
        vocalizeBias: 1,
        birds: Array.from({ length: tree.birdCount }, () => {
          const bird = makeBird(tree, nextBirdId);
          nextBirdId += 1;
          return bird;
        }),
      })),
    },
    sequence: {
      worldPatterns: mapTrees(() => null),
      jungleEditPlans: mapTrees(() => null),
      lastSequenceStep: mapTrees(() => null),
    },
    control: {
      treeControl: mapTrees(() => 'AGENT'),
      agentResumeAt: mapTrees(() => null),
      tempo: {
        bpm: CONFIG.tempo.defaultBpm,
        barsPerDay: CONFIG.tempo.barsPerDay,
        beatsPerBar: CONFIG.tempo.beatsPerBar,
      },
    },
  };
}

function makeConductorState() {
  const currentFrame = makeFrame();
  const currentChord = chordFromFrame(currentFrame, CONFIG.harmony);
  return {
    conductor: {
      cursor: {
        seasonIdx: 0,
        seasonDay: 0,
        seasonLength: CONFIG.harmony.defaultSeasonLength,
        daysSinceChange: 2,
        currentColorId: currentFrame.color.id,
        daysInColor: 1,
        progressionId: currentFrame.progressionId,
        lastDuskShiftDay: null,
        lastDuskShiftCycle: -1,
      },
      treeScoreHistory: mapTrees(() => []),
      harmonyScoreHistory: mapTrees(() => []),
      pendingNext: null,
      currentFrame,
      currentChord,
      pendingPlan: null,
      pendingSource: null,
      pendingReviewedDay: null,
      duskColorShiftPlanned: false,
      patternHistory: [],
      holdState: mapTrees(() => ({
        counter: 0,
        loops: CONFIG.agent.defaultHoldLoops,
        generation: 0,
        pitchDirection: 1,
      })),
      hCounts: mapTrees(() => ({
        skeleton: 0,
        color: 0,
        outside: 0,
      })),
      hPerchStart: [],
    },
    sequence: {
      bridgeCurrent: emptyGrid(),
      bridgePrevious: null,
      reviewedPattern: null,
      plannedPatterns: mapTrees(() => null),
    },
    control: {
      masterControl: 'AGENT',
      pendingUserSeasonLength: null,
    },
  };
}

function makeParts({ paused = false } = {}) {
  return {
    worldGeneration: 'generation-test',
    seed: ROOT_SEED,
    revision: 0,
    eventSeq: 0,
    worldState: makeWorldState(),
    conductorState: makeConductorState(),
    worldRng: createDeterministicRng(ROOT_SEED),
    conductorRng: createDeterministicRng(deriveConductorSeed(ROOT_SEED)),
    paused,
  };
}

function createValidCheckpoint() {
  return createSimulationCheckpoint(makeParts());
}

function createReachablePostDuskCheckpoint() {
  const checkpoint = cloneJson(createValidCheckpoint());
  const { cursor, currentFrame } = checkpoint.conductor;
  const dayColors = colorOptions(
    currentFrame.season,
    CONFIG.harmony,
    cursor.seasonDay,
    'day',
    cursor.progressionId,
  );
  const dayColorIndex = dayColors.findIndex(
    (color) => color.id === cursor.currentColorId,
  );
  assert.notEqual(dayColorIndex, -1, 'fixture cursor color must be a day option');

  currentFrame.period = 'night';
  currentFrame.color = dayColors[(dayColorIndex + 1) % dayColors.length];
  checkpoint.conductor.currentChord = chordFromFrame(currentFrame, CONFIG.harmony);
  checkpoint.conductor.duskColorShiftPlanned = false;
  cursor.lastDuskShiftDay = checkpoint.world.clock.day;
  cursor.lastDuskShiftCycle = Math.floor(cursor.seasonDay / 4);
  checkpoint.world.clock.phase = CONFIG.sim.duskPhase;
  checkpoint.world.clock.daylight = daylightFromPhase(checkpoint.world.clock.phase);
  return checkpoint;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validate(checkpoint, expected = {
  seed: ROOT_SEED,
  configRevision: 'phase2-domain-config-v1',
}) {
  return validateSimulationCheckpoint(checkpoint, expected);
}

function assertInvalid(base, mutate, label) {
  const candidate = cloneJson(base);
  mutate(candidate);
  let result;
  assert.doesNotThrow(() => {
    result = validate(candidate);
  }, label);
  assert.equal(result, false, label);
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function assertCheckpointError(operation) {
  assert.throws(operation, (error) => {
    assert.equal(error?.code, 'INVALID_SIMULATION_CHECKPOINT');
    assert.equal(error?.message, 'INVALID_SIMULATION_CHECKPOINT');
    return true;
  });
}

test('aggregator 生成固定身份、独立 deep-freeze 的 strict JSON checkpoint', () => {
  assert.equal(SIMULATION_CHECKPOINT_SCHEMA_VERSION, 1);
  assert.equal(SIMULATION_CONFIG_REVISION, 'phase2-domain-config-v1');
  const parts = makeParts({ paused: true });
  const checkpoint = createSimulationCheckpoint(parts);

  assert.deepEqual(Object.keys(checkpoint), TOP_LEVEL_KEYS);
  assert.deepEqual(Object.keys(checkpoint.control), CONTROL_KEYS);
  assert.equal(Object.keys(checkpoint.control).at(-1), 'paused');
  assert.deepEqual(JSON.parse(JSON.stringify(checkpoint)), checkpoint);
  assert.equal(validate(checkpoint), true);
  assert.equal(checkpoint.worldId, 'default');
  assert.equal(checkpoint.protocolVersion, 1);
  assert.equal(checkpoint.snapshotSchemaVersion, 1);
  assert.equal(checkpoint.schemaVersion, 1);
  assert.equal(checkpoint.configRevision, SIMULATION_CONFIG_REVISION);
  assert.equal(checkpoint.rng.algorithm, 'mulberry32-v1');
  assert.equal(checkpoint.control.paused, true);
  assertDeepFrozen(checkpoint);

  assert.notStrictEqual(checkpoint.world, parts.worldState.world);
  assert.notStrictEqual(checkpoint.conductor, parts.conductorState.conductor);
  parts.worldState.world.clock.simTime = 99;
  assert.equal(checkpoint.world.clock.simTime, 0);
});

test('validator 对错误 fixed identity、expected identity 与序号始终 non-throwing false', () => {
  const checkpoint = createValidCheckpoint();
  const cases = [
    ['worldId', (value) => { value.worldId = 'other'; }],
    ['protocolVersion', (value) => { value.protocolVersion = 2; }],
    ['snapshotSchemaVersion', (value) => { value.snapshotSchemaVersion = 2; }],
    ['schemaVersion', (value) => { value.schemaVersion = 2; }],
    ['configRevision', (value) => { value.configRevision = 'other'; }],
    ['seed', (value) => { value.seed = 8; }],
    ['empty generation', (value) => { value.worldGeneration = ''; }],
    ['blank generation', (value) => { value.worldGeneration = '   '; }],
    ['negative revision', (value) => { value.revision = -1; }],
    ['fraction revision', (value) => { value.revision = 0.5; }],
    ['unsafe revision', (value) => { value.revision = Number.MAX_SAFE_INTEGER + 1; }],
    ['negative eventSeq', (value) => { value.eventSeq = -1; }],
    ['unsafe eventSeq', (value) => { value.eventSeq = Number.MAX_SAFE_INTEGER + 1; }],
  ];
  for (const [label, mutate] of cases) assertInvalid(checkpoint, mutate, label);

  assert.equal(validateSimulationCheckpoint(checkpoint, {
    seed: 8,
    configRevision: SIMULATION_CONFIG_REVISION,
  }), false);
  assert.equal(validateSimulationCheckpoint(checkpoint, {
    seed: ROOT_SEED,
    configRevision: 'other',
  }), false);
  assert.equal(validateSimulationCheckpoint(checkpoint, null), false);
});

test('每个 frozen section 都拒绝缺键或额外键', () => {
  const checkpoint = createValidCheckpoint();
  const cases = [
    ['top missing', (value) => { delete value.world; }],
    ['top extra', (value) => { value.extra = true; }],
    ['world missing', (value) => { delete value.world.clock; }],
    ['world extra', (value) => { value.world.extra = true; }],
    ['clock extra', (value) => { value.world.clock.extra = true; }],
    ['tree extra', (value) => { value.world.trees[0].extra = true; }],
    ['stats missing', (value) => { delete value.world.trees[0].stats.dayTime; }],
    ['bird extra', (value) => { value.world.trees[0].birds[0].extra = true; }],
    ['position missing', (value) => { delete value.world.trees[0].birds[0].pos.y; }],
    ['sequence extra', (value) => { value.sequence.extra = true; }],
    ['grid extra', (value) => { value.sequence.bridgeCurrent.extra = true; }],
    ['voice extra', (value) => { value.sequence.bridgeCurrent.voices.pad.extra = true; }],
    ['lane missing', (value) => {
      delete value.sequence.bridgeCurrent.voices.pad.lanes[0].steps;
    }],
    ['conductor extra', (value) => { value.conductor.extra = true; }],
    ['cursor missing', (value) => { delete value.conductor.cursor.seasonIdx; }],
    ['frame extra', (value) => { value.conductor.currentFrame.extra = true; }],
    ['skeleton extra', (value) => {
      value.conductor.currentFrame.skeleton.extra = true;
    }],
    ['color missing', (value) => {
      delete value.conductor.currentFrame.color.notes;
    }],
    ['chord extra', (value) => { value.conductor.currentChord.extra = true; }],
    ['species menus extra', (value) => {
      value.conductor.currentChord.speciesMenus.extra = [];
    }],
    ['hold state extra', (value) => {
      value.conductor.holdState.pad.extra = true;
    }],
    ['h count missing', (value) => {
      delete value.conductor.hCounts.pad.outside;
    }],
    ['rng extra', (value) => { value.rng.extra = true; }],
    ['rng cursor extra', (value) => { value.rng.world.extra = true; }],
    ['control extra', (value) => { value.control.extra = true; }],
    ['tempo missing', (value) => { delete value.control.tempo.bpm; }],
  ];
  for (const [label, mutate] of cases) assertInvalid(checkpoint, mutate, label);
});

test('strict JSON tree 拒绝 raw 非 JSON 值、accessor、symbol、prototype、cycle 与 alias', () => {
  const checkpoint = createValidCheckpoint();
  const rawValues = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    undefined,
    () => {},
    Promise.resolve(null),
    1n,
    Symbol('value'),
  ];
  for (const raw of rawValues) {
    const candidate = cloneJson(checkpoint);
    candidate.conductor.pendingPlan = raw;
    let result;
    assert.doesNotThrow(() => {
      result = validate(candidate);
    });
    assert.equal(result, false);
  }

  const accessor = cloneJson(checkpoint);
  let getterCalls = 0;
  Object.defineProperty(accessor.world.clock, 'simTime', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error('validator must inspect descriptor first');
    },
  });
  assert.equal(validate(accessor), false);
  assert.equal(getterCalls, 0);

  const symbolKey = cloneJson(checkpoint);
  symbolKey[Symbol('extra')] = true;
  assert.equal(validate(symbolKey), false);

  const negativeZero = cloneJson(checkpoint);
  negativeZero.world.clock.simTime = -0;
  assert.equal(validate(negativeZero), false);

  const arrayHole = cloneJson(checkpoint);
  delete arrayHole.sequence.bridgeCurrent.voices.pad.lanes[0].steps[0];
  assert.equal(validate(arrayHole), false);

  const arrayCustomKey = cloneJson(checkpoint);
  Object.defineProperty(
    arrayCustomKey.sequence.bridgeCurrent.voices.pad.lanes[0].steps,
    'hidden',
    { value: true },
  );
  assert.equal(validate(arrayCustomKey), false);

  const arraySymbolKey = cloneJson(checkpoint);
  arraySymbolKey.sequence.bridgeCurrent.voices.pad.lanes[0].steps[Symbol('extra')] = true;
  assert.equal(validate(arraySymbolKey), false);

  const arrayAccessor = cloneJson(checkpoint);
  Object.defineProperty(
    arrayAccessor.sequence.bridgeCurrent.voices.pad.lanes[0].steps,
    '0',
    {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error('validator must not invoke array getter');
      },
    },
  );
  assert.equal(validate(arrayAccessor), false);
  assert.equal(getterCalls, 0);

  const nonEnumerableObjectKey = cloneJson(checkpoint);
  Object.defineProperty(nonEnumerableObjectKey.world.clock, 'hidden', { value: true });
  assert.equal(validate(nonEnumerableObjectKey), false);

  const nonPlain = cloneJson(checkpoint);
  nonPlain.conductor.pendingPlan = new (class NonPlain {})();
  assert.equal(validate(nonPlain), false);

  const nullPrototype = cloneJson(checkpoint);
  Object.setPrototypeOf(nullPrototype.world.clock, null);
  assert.equal(validate(nullPrototype), false);

  const dateValue = cloneJson(checkpoint);
  dateValue.world.clock = new Date(0);
  assert.equal(validate(dateValue), false);

  const mapValue = cloneJson(checkpoint);
  mapValue.world.clock = new Map();
  assert.equal(validate(mapValue), false);

  const cycle = cloneJson(checkpoint);
  cycle.world.clock.self = cycle.world.clock;
  assert.equal(validate(cycle), false);

  const sharedAlias = cloneJson(checkpoint);
  sharedAlias.sequence.bridgePrevious = sharedAlias.sequence.bridgeCurrent;
  assert.equal(validate(sharedAlias), false);

  const filledAlias = cloneJson(checkpoint);
  const pattern = mapTrees(() => emptySummary());
  filledAlias.conductor.patternHistory = new Array(2).fill(pattern);
  assert.equal(validate(filledAlias), false);
});

test('validator 对 root checkpoint Proxy 在 descriptor/semantic 验证后 fail-closed 且不触发 get trap', () => {
  const checkpoint = createValidCheckpoint();
  let checkpointGets = 0;
  const checkpointProxy = new Proxy(checkpoint, {
    get() {
      checkpointGets += 1;
      throw new Error('must not invoke checkpoint proxy get trap');
    },
  });
  let result;
  assert.doesNotThrow(() => {
    result = validate(checkpointProxy);
  });
  assert.equal(result, false);
  assert.equal(checkpointGets, 0);
});

test('validator 对 nested checkpoint Proxy 在 descriptor/semantic 验证后 fail-closed 且不触发 get trap', () => {
  const checkpoint = cloneJson(createValidCheckpoint());
  let checkpointGets = 0;
  checkpoint.world.clock = new Proxy(checkpoint.world.clock, {
    get() {
      checkpointGets += 1;
      throw new Error('must not invoke nested checkpoint proxy get trap');
    },
  });
  let result;
  assert.doesNotThrow(() => {
    result = validate(checkpoint);
  });
  assert.equal(result, false);
  assert.equal(checkpointGets, 0);
});

test('validator 对 expected Proxy 在 descriptor/semantic 验证后 fail-closed 且不触发 get trap', () => {
  const checkpoint = createValidCheckpoint();
  const expected = {
    seed: ROOT_SEED,
    configRevision: SIMULATION_CONFIG_REVISION,
  };
  let expectedGets = 0;
  const expectedProxy = new Proxy(expected, {
    get() {
      expectedGets += 1;
      throw new Error('must not invoke expected proxy get trap');
    },
  });
  let result;
  assert.doesNotThrow(() => {
    result = validateSimulationCheckpoint(checkpoint, expectedProxy);
  });
  assert.equal(result, false);
  assert.equal(expectedGets, 0);
});

test('validator 对 revoked expected Proxy 保持 non-throwing false', () => {
  const checkpoint = createValidCheckpoint();
  const expected = {
    seed: ROOT_SEED,
    configRevision: SIMULATION_CONFIG_REVISION,
  };
  const revoked = Proxy.revocable(expected, {});
  revoked.revoke();
  let result;
  assert.doesNotThrow(() => {
    result = validateSimulationCheckpoint(checkpoint, revoked.proxy);
  });
  assert.equal(result, false);
});

test('configured tree maps 与 bird ID/ownership 必须精确完整', () => {
  const checkpoint = createValidCheckpoint();
  const cases = [
    ['tree order', (value) => { value.world.trees.reverse(); }],
    ['tree id', (value) => { value.world.trees[0].id = 'other'; }],
    ['tree count', (value) => { value.world.trees.pop(); }],
    ['map missing', (value) => { delete value.sequence.worldPatterns.pad; }],
    ['map extra', (value) => { value.control.treeControl.other = 'AGENT'; }],
    ['bird duplicate', (value) => {
      value.world.trees[0].birds[1].id = value.world.trees[0].birds[0].id;
    }],
    ['bird gap', (value) => { value.world.trees[0].birds[0].id = 99; }],
    ['bird wrong tree', (value) => {
      value.world.trees[0].birds[0].treeId = 'melody';
    }],
    ['configured bird count', (value) => { value.world.trees[0].birds.pop(); }],
  ];
  for (const [label, mutate] of cases) assertInvalid(checkpoint, mutate, label);
});

test('branch、sequence、stats 与 control 引用越界均拒绝', () => {
  const checkpoint = createValidCheckpoint();
  const cases = [
    ['flying branch', (value) => {
      value.world.trees[0].birds[0].branchId = 0;
    }],
    ['flying slot', (value) => {
      value.world.trees[0].birds[0].slotIndex = 0;
    }],
    ['flying sequence address', (value) => {
      value.world.trees[0].birds[0].sequenceAddress = {
        pitchBranchId: 0,
        stepIndex: 0,
        stepCount: STEP_COUNT,
      };
    }],
    ['perched missing address', (value) => {
      const bird = value.world.trees[0].birds[0];
      bird.state = 'perched';
      bird.branchId = 0;
      bird.slotIndex = 0;
    }],
    ['perched address branch mismatch', (value) => {
      const bird = value.world.trees[0].birds[0];
      bird.state = 'perched';
      bird.branchId = 0;
      bird.slotIndex = 0;
      bird.sequenceAddress = {
        pitchBranchId: 1,
        stepIndex: 0,
        stepCount: STEP_COUNT,
      };
    }],
    ['slot range', (value) => {
      const bird = value.world.trees[0].birds[0];
      bird.state = 'perched';
      bird.branchId = 0;
      bird.slotIndex = CONFIG.tree.perchSlotsPerBranch;
      bird.sequenceAddress = {
        pitchBranchId: 0,
        stepIndex: 0,
        stepCount: STEP_COUNT,
      };
    }],
    ['return branch without cause', (value) => {
      value.world.trees[0].birds[0].returnBranch = 0;
    }],
    ['return cause without branch', (value) => {
      value.world.trees[0].birds[0].returnCause = 'hop';
    }],
    ['return metadata on unsupported species', (value) => {
      value.world.trees[0].birds[0].returnBranch = 0;
      value.world.trees[0].birds[0].returnCause = 'hop';
    }],
    ['manual return cause', (value) => {
      const textureTree = value.world.trees.find((tree) => tree.id === 'texture');
      textureTree.birds[0].lastBranch = 0;
      textureTree.birds[0].returnBranch = 0;
      textureTree.birds[0].returnCause = 'manual';
    }],
    ['return branch differs from last branch', (value) => {
      const textureTree = value.world.trees.find((tree) => tree.id === 'texture');
      textureTree.birds[0].lastBranch = 1;
      textureTree.birds[0].returnBranch = 0;
      textureTree.birds[0].returnCause = 'hop';
    }],
    ['switch quota', (value) => {
      value.world.trees[0].birds[0].switchesUsed = 1;
    }],
    ['perched return metadata', (value) => {
      const bird = value.world.trees[0].birds[0];
      bird.state = 'perched';
      bird.branchId = 0;
      bird.slotIndex = 0;
      bird.sequenceAddress = {
        pitchBranchId: 0,
        stepIndex: 0,
        stepCount: STEP_COUNT,
      };
      bird.returnBranch = 0;
      bird.returnCause = 'hop';
    }],
    ['home branch', (value) => { value.world.trees[0].birds[0].homeBranch = 99; }],
    ['target branch', (value) => { value.world.trees[0].birds[0].targetBranch = 99; }],
    ['last branch', (value) => { value.world.trees[0].birds[0].lastBranch = 99; }],
    ['return branch', (value) => { value.world.trees[0].birds[0].returnBranch = 99; }],
    ['branch preference length', (value) => {
      value.world.trees[0].branchPreference.pop();
    }],
    ['visit count length', (value) => {
      value.world.trees[0].birds[0].visitCounts.pop();
    }],
    ['bad state', (value) => { value.world.trees[0].birds[0].state = 'other'; }],
    ['bad mode', (value) => { value.world.trees[0].birds[0].mode = 'other'; }],
    ['per-bird stat owner', (value) => {
      value.world.trees[0].stats.perBirdSwitches['99'] = 1;
    }],
    ['tree control', (value) => { value.control.treeControl.pad = 'other'; }],
    ['agent resume', (value) => { value.control.agentResumeAt.pad = -1; }],
    ['USER tree resume', (value) => {
      value.control.treeControl.pad = 'USER';
      value.control.agentResumeAt.pad = 1;
    }],
    ['master control', (value) => { value.control.masterControl = 'other'; }],
    ['pending season length', (value) => {
      value.control.pendingUserSeasonLength = 99;
    }],
    ['hold map key set', (value) => { delete value.conductor.holdState.pad; }],
    ['h perch bird', (value) => {
      value.conductor.hPerchStart.push({
        birdId: 99,
        treeId: 'pad',
        key: 'skeleton',
        start: 0,
      });
    }],
    ['last step without pattern', (value) => {
      value.sequence.lastSequenceStep.pad = 0;
    }],
  ];
  for (const [label, mutate] of cases) assertInvalid(checkpoint, mutate, label);
});

test('Sequence grid/summary 坐标、tree key 与 cell 引用严格校验', () => {
  const checkpoint = createValidCheckpoint();
  const validSummary = emptySummary([{
    pitchBranchId: 0,
    stepIndex: 0,
    count: 1,
  }]);
  const valid = cloneJson(checkpoint);
  valid.sequence.worldPatterns.pad = validSummary;
  valid.sequence.plannedPatterns.pad = cloneJson(validSummary);
  valid.sequence.lastSequenceStep.pad = 0;
  valid.sequence.bridgeCurrent.voices.pad.lanes[0].steps[0] = [{
    birdId: 0,
    cause: 'sequence',
    legacyBranchId: 0,
  }];
  assert.equal(validate(valid), true);

  const cases = [
    ['grid voice key', (value) => {
      delete value.sequence.bridgeCurrent.voices.pad;
    }],
    ['voice tree id', (value) => {
      value.sequence.bridgeCurrent.voices.pad.treeId = 'melody';
    }],
    ['lane pitch id', (value) => {
      value.sequence.bridgeCurrent.voices.pad.lanes[0].pitchBranchId = 1;
    }],
    ['step length', (value) => {
      value.sequence.bridgeCurrent.voices.pad.lanes[0].steps.pop();
    }],
    ['grid cell bird', (value) => {
      value.sequence.bridgeCurrent.voices.pad.lanes[0].steps[0] = [{
        birdId: 99,
        cause: 'sequence',
        legacyBranchId: 0,
      }];
    }],
    ['grid cell wrong tree owner', (value) => {
      value.sequence.bridgeCurrent.voices.pad.lanes[0].steps[0] = [{
        birdId: CONFIG.trees[0].birdCount,
        cause: 'sequence',
        legacyBranchId: 0,
      }];
    }],
    ['summary pitch', (value) => {
      value.sequence.plannedPatterns.pad = emptySummary([{
        pitchBranchId: BRANCH_COUNT,
        stepIndex: 0,
        count: 1,
      }]);
    }],
    ['summary step', (value) => {
      value.sequence.worldPatterns.pad = emptySummary([{
        pitchBranchId: 0,
        stepIndex: STEP_COUNT,
        count: 1,
      }]);
    }],
    ['summary duplicate cell', (value) => {
      const cell = { pitchBranchId: 0, stepIndex: 0, count: 1 };
      value.sequence.plannedPatterns.pad = emptySummary([cell, { ...cell }]);
    }],
    ['summary count', (value) => {
      value.sequence.plannedPatterns.pad = emptySummary([{
        pitchBranchId: 0,
        stepIndex: 0,
        count: CONFIG.trees[0].birdCount + 1,
      }]);
    }],
    ['last sequence step', (value) => {
      value.sequence.lastSequenceStep.pad = STEP_COUNT;
    }],
  ];
  for (const [label, mutate] of cases) assertInvalid(checkpoint, mutate, label);
});

test('full checkpoint 仅允许 world-owned pattern/address 使用自身可变维度', () => {
  const parts = makeParts();
  parts.worldState.sequence.worldPatterns.pad = variableWorldSummary(3, 8, [
    { pitchBranchId: 2, stepIndex: 7, count: 1 },
  ]);
  parts.worldState.sequence.worldPatterns.texture = variableWorldSummary(5, 8, [
    { pitchBranchId: 4, stepIndex: 6, count: 1 },
  ]);
  parts.worldState.sequence.worldPatterns.bass = variableWorldSummary(1, 64, [
    { pitchBranchId: 0, stepIndex: 63, count: 1 },
  ]);
  parts.worldState.sequence.lastSequenceStep.pad = 7;
  parts.worldState.sequence.lastSequenceStep.texture = 6;
  parts.worldState.sequence.lastSequenceStep.bass = 63;
  const padBird = parts.worldState.world.trees[0].birds[0];
  padBird.state = 'perched';
  padBird.branchId = 2;
  padBird.slotIndex = 0;
  padBird.mode = 'sequence';
  padBird.activeToday = true;
  padBird.targetBranch = 2;
  padBird.sequenceAddress = {
    pitchBranchId: 2,
    stepIndex: 7,
    stepCount: 8,
  };
  const bassBird = parts.worldState.world.trees[2].birds[0];
  bassBird.state = 'perched';
  bassBird.branchId = 0;
  bassBird.slotIndex = 0;
  bassBird.mode = 'sequence';
  bassBird.activeToday = true;
  bassBird.targetBranch = 0;
  bassBird.sequenceAddress = {
    pitchBranchId: 0,
    stepIndex: 63,
    stepCount: 64,
  };

  const checkpoint = createSimulationCheckpoint(parts);
  assert.equal(validate(checkpoint), true);
  assert.equal(checkpoint.sequence.worldPatterns.pad.pitchBranchCount, 3);
  assert.equal(checkpoint.sequence.worldPatterns.pad.stepCount, 8);
  assert.equal(checkpoint.sequence.worldPatterns.texture.pitchBranchCount, 5);
  assert.equal(checkpoint.sequence.worldPatterns.texture.stepCount, 8);
  assert.equal(checkpoint.sequence.worldPatterns.bass.pitchBranchCount, 1);
  assert.equal(checkpoint.sequence.worldPatterns.bass.stepCount, 64);
  assert.deepEqual(
    checkpoint.world.trees[0].birds[0].sequenceAddress,
    { pitchBranchId: 2, stepIndex: 7, stepCount: 8 },
  );
  assert.equal(checkpoint.sequence.lastSequenceStep.pad, 7);
  assert.deepEqual(
    checkpoint.world.trees[2].birds[0].sequenceAddress,
    { pitchBranchId: 0, stepIndex: 63, stepCount: 64 },
  );
  assert.equal(checkpoint.sequence.lastSequenceStep.bass, 63);
  assert.equal(checkpoint.sequence.bridgeCurrent.pitchBranchCount, BRANCH_COUNT);
  assert.equal(checkpoint.sequence.bridgeCurrent.stepCount, STEP_COUNT);
  assert.equal(checkpoint.sequence.plannedPatterns.pad, null);

  const cases = [
    ['world pitch count zero', (value) => {
      value.sequence.worldPatterns.pad.pitchBranchCount = 0;
    }],
    ['world pitch count above configured', (value) => {
      value.sequence.worldPatterns.pad.pitchBranchCount = BRANCH_COUNT + 1;
    }],
    ['world step count zero', (value) => {
      value.sequence.worldPatterns.pad.stepCount = 0;
    }],
    ['world step count above maximum', (value) => {
      value.sequence.worldPatterns.pad.stepCount = 65;
    }],
    ['world cell beyond own pitch count', (value) => {
      value.sequence.worldPatterns.pad.occupiedCells[0].pitchBranchId = 3;
    }],
    ['world cell beyond own step count', (value) => {
      value.sequence.worldPatterns.pad.occupiedCells[0].stepIndex = 8;
    }],
    ['world last step beyond own pattern', (value) => {
      value.sequence.lastSequenceStep.pad = 8;
    }],
    ['address step count zero', (value) => {
      value.world.trees[0].birds[0].sequenceAddress.stepCount = 0;
    }],
    ['address step count above maximum', (value) => {
      value.world.trees[0].birds[0].sequenceAddress.stepCount = 65;
    }],
    ['address step beyond own count', (value) => {
      value.world.trees[0].birds[0].sequenceAddress.stepIndex = 8;
    }],
    ['bridge pitch count remains canonical', (value) => {
      value.sequence.bridgeCurrent.pitchBranchCount = 3;
    }],
    ['bridge step count remains canonical', (value) => {
      value.sequence.bridgeCurrent.stepCount = 8;
    }],
    ['planned pattern remains canonical', (value) => {
      value.sequence.plannedPatterns.pad = variableWorldSummary(3, 8);
    }],
  ];
  for (const [label, mutate] of cases) assertInvalid(checkpoint, mutate, label);
});

test('bridge previous、reviewed pattern 与 pattern history 尾项必须同源', () => {
  const checkpoint = cloneJson(createValidCheckpoint());
  checkpoint.sequence.bridgePrevious = emptyGrid();
  checkpoint.sequence.reviewedPattern = emptyGrid();
  checkpoint.conductor.patternHistory = [mapTrees(() => emptySummary())];
  assert.equal(validate(checkpoint), true);

  const cases = [
    ['previous without reviewed', (value) => {
      value.sequence.reviewedPattern = null;
    }],
    ['reviewed without previous', (value) => {
      value.sequence.bridgePrevious = null;
    }],
    ['completed bridge without history', (value) => {
      value.conductor.patternHistory = [];
    }],
    ['history without completed bridge', (value) => {
      value.sequence.bridgePrevious = null;
      value.sequence.reviewedPattern = null;
    }],
    ['previous/reviewed mismatch', (value) => {
      value.sequence.reviewedPattern.voices.pad.lanes[0].steps[0] = [{
        birdId: 0,
        cause: 'sequence',
        legacyBranchId: 0,
      }];
    }],
    ['history tail mismatch', (value) => {
      value.conductor.patternHistory[0].pad = emptySummary([{
        pitchBranchId: 0,
        stepIndex: 0,
        count: 1,
      }]);
    }],
  ];
  for (const [label, mutate] of cases) assertInvalid(checkpoint, mutate, label);
});

test('frame/chord 必须与 cursor 和 CONFIG 的纯函数派生完全一致', () => {
  const checkpoint = createValidCheckpoint();
  const cases = [
    ['season length range', (value) => {
      value.conductor.cursor.seasonLength = 7;
      value.conductor.currentFrame.seasonLength = 7;
    }],
    ['progression step', (value) => {
      value.conductor.currentFrame.progressionStep = 1;
      value.conductor.currentChord.progressionStep = 1;
    }],
    ['progression cycle', (value) => {
      value.conductor.currentFrame.progressionCycle = 1;
    }],
    ['skeleton derivation', (value) => {
      value.conductor.currentFrame.skeleton.notes[0] += 1;
    }],
    ['color id', (value) => {
      value.conductor.currentFrame.color.id = 'other';
      value.conductor.cursor.currentColorId = 'other';
    }],
    ['color notes', (value) => {
      value.conductor.currentFrame.color.notes[0] += 1;
    }],
    ['chord derivation', (value) => {
      value.conductor.currentChord.notes[0] += 1;
    }],
  ];
  for (const [label, mutate] of cases) assertInvalid(checkpoint, mutate, label);
});

test('validator 接受真实可达的 post-dusk successor 并拒绝伪造的昼夜关系', () => {
  const postDusk = createReachablePostDuskCheckpoint();
  assert.equal(validate(postDusk), true, 'reachable post-dusk checkpoint');

  const dayColors = colorOptions(
    postDusk.conductor.currentFrame.season,
    CONFIG.harmony,
    postDusk.conductor.cursor.seasonDay,
    'day',
    postDusk.conductor.cursor.progressionId,
  );
  const successorIndex = dayColors.findIndex(
    (color) => color.id === postDusk.conductor.currentFrame.color.id,
  );
  const cases = [
    ['wrong dusk successor', (value) => {
      value.conductor.currentFrame.color =
        dayColors[(successorIndex + 1) % dayColors.length];
      value.conductor.currentChord = chordFromFrame(
        value.conductor.currentFrame,
        CONFIG.harmony,
      );
    }],
    ['wrong last dusk day', (value) => {
      value.conductor.cursor.lastDuskShiftDay = value.world.clock.day - 1;
    }],
    ['wrong last dusk cycle', (value) => {
      value.conductor.cursor.lastDuskShiftCycle += 1;
    }],
    ['dusk shift still planned', (value) => {
      value.conductor.duskColorShiftPlanned = true;
    }],
    ['night frame before dusk', (value) => {
      value.world.clock.phase = CONFIG.sim.duskPhase - 0.01;
      value.world.clock.daylight = daylightFromPhase(value.world.clock.phase);
    }],
  ];
  for (const [label, mutate] of cases) assertInvalid(postDusk, mutate, label);

  const dayMismatch = cloneJson(createValidCheckpoint());
  const dayOptions = colorOptions(
    dayMismatch.conductor.currentFrame.season,
    CONFIG.harmony,
    dayMismatch.conductor.cursor.seasonDay,
    'day',
    dayMismatch.conductor.cursor.progressionId,
  );
  dayMismatch.conductor.cursor.currentColorId = dayOptions[1].id;
  assert.equal(validate(dayMismatch), false, 'day frame/cursor color mismatch');
});

test('tree stats 的 switch 总数与 dwell 两组样本必须同步', () => {
  const checkpoint = createValidCheckpoint();
  const cases = [
    ['switch total', (value) => {
      value.world.trees[0].stats.switches = 1;
    }],
    ['per-bird switch total', (value) => {
      value.world.trees[0].stats.perBirdSwitches['0'] = 1;
    }],
    ['per-bird switch cursor', (value) => {
      value.world.trees[0].stats.switches = 1;
      value.world.trees[0].stats.perBirdSwitches['0'] = 1;
    }],
    ['dwell sample pair', (value) => {
      value.world.trees[0].stats.dwellSamples.push(1);
    }],
    ['dwell beat sample pair', (value) => {
      value.world.trees[0].stats.dwellBeatSamples.push(1);
    }],
  ];
  for (const [label, mutate] of cases) assertInvalid(checkpoint, mutate, label);
});

test('hPerchStart 只能引用当前 perched bird，分类必须与 branch 一致', () => {
  const valid = cloneJson(createValidCheckpoint());
  const bird = valid.world.trees[0].birds[0];
  bird.state = 'perched';
  bird.branchId = 0;
  bird.slotIndex = 0;
  bird.sequenceAddress = {
    pitchBranchId: 0,
    stepIndex: 0,
    stepCount: STEP_COUNT,
  };
  valid.conductor.hPerchStart.push({
    birdId: bird.id,
    treeId: bird.treeId,
    key: 'skeleton',
    start: 0,
  });
  assert.equal(validate(valid), true);

  const checkpoint = createValidCheckpoint();
  assertInvalid(checkpoint, (value) => {
    value.conductor.hPerchStart.push({
      birdId: 0,
      treeId: 'pad',
      key: 'skeleton',
      start: 0,
    });
  }, 'flying bird record');
  assertInvalid(valid, (value) => {
    value.conductor.hPerchStart[0].key = 'color';
  }, 'branch class');
});

test('provider-free texture harmony 只允许零计数、null 历史且无在鸣记录', () => {
  const checkpoint = createValidCheckpoint();
  const textureTree = CONFIG.trees.find((tree) => tree.species === 'texture');
  assertInvalid(checkpoint, (value) => {
    value.conductor.hCounts[textureTree.id].color = 1;
  }, 'texture hCounts');
  assertInvalid(checkpoint, (value) => {
    value.conductor.harmonyScoreHistory[textureTree.id] = [0.7];
  }, 'texture harmony history');

  const active = cloneJson(checkpoint);
  const tree = active.world.trees.find((entry) => entry.id === textureTree.id);
  const bird = tree.birds[0];
  bird.state = 'perched';
  bird.branchId = 0;
  bird.slotIndex = 0;
  bird.sequenceAddress = {
    pitchBranchId: 0,
    stepIndex: 0,
    stepCount: STEP_COUNT,
  };
  assert.equal(validate(active), true, 'texture perched world state remains reachable');
  active.conductor.hPerchStart.push({
    birdId: bird.id,
    treeId: textureTree.id,
    key: 'skeleton',
    start: 0,
  });
  assert.equal(validate(active), false, 'texture active record');
});

test('lastDuskShiftDay 不得晚于当前 world day', () => {
  const checkpoint = cloneJson(createValidCheckpoint());
  checkpoint.conductor.cursor.lastDuskShiftDay = checkpoint.world.clock.day + 1;
  checkpoint.conductor.cursor.lastDuskShiftCycle = 0;
  assert.equal(validate(checkpoint), false);
});

test('AGENT→USER→dusk→AGENT 的 day frame + planned true 保持可恢复', () => {
  const checkpoint = cloneJson(createValidCheckpoint());
  checkpoint.control.masterControl = 'AGENT';
  checkpoint.conductor.currentFrame.period = 'day';
  checkpoint.conductor.duskColorShiftPlanned = true;
  checkpoint.world.clock.phase = CONFIG.sim.duskPhase;
  checkpoint.world.clock.daylight = daylightFromPhase(checkpoint.world.clock.phase);
  assert.equal(validate(checkpoint), true);
});

test('RNG algorithm、范围、drawCount 与 root/derived seed 关系严格校验', () => {
  const checkpoint = createValidCheckpoint();
  const cases = [
    ['algorithm', (value) => { value.rng.algorithm = 'other'; }],
    ['world state negative', (value) => { value.rng.world.state = -1; }],
    ['world state range', (value) => { value.rng.world.state = 0x1_0000_0000; }],
    ['world draw negative', (value) => { value.rng.world.drawCount = -1; }],
    ['world draw unsafe', (value) => {
      value.rng.world.drawCount = Number.MAX_SAFE_INTEGER + 1;
    }],
    ['world relation', (value) => { value.rng.world.state = 8; }],
    ['conductor relation', (value) => { value.rng.conductor.state = ROOT_SEED; }],
    ['conductor uses world cursor', (value) => {
      value.rng.conductor = cloneJson(value.rng.world);
    }],
  ];
  for (const [label, mutate] of cases) assertInvalid(checkpoint, mutate, label);
});

test('clock/tempo/dayLength、phase/daylight 与 tree tempo 范围保持一致', () => {
  const checkpoint = createValidCheckpoint();
  const meterVariant = cloneJson(checkpoint);
  meterVariant.control.tempo.beatsPerBar = 2;
  meterVariant.control.tempo.barsPerDay = 8;
  meterVariant.world.clock.dayLength = 16;
  assert.equal(validate(meterVariant), true);

  const cases = [
    ['clock bpm mismatch', (value) => { value.world.clock.bpm = 61; }],
    ['day length mismatch', (value) => { value.world.clock.dayLength += 0.01; }],
    ['phase low', (value) => { value.world.clock.phase = -0.01; }],
    ['phase high', (value) => { value.world.clock.phase = 1; }],
    ['daylight low', (value) => { value.world.clock.daylight = -0.01; }],
    ['daylight high', (value) => { value.world.clock.daylight = 1.01; }],
    ['tempo bpm low', (value) => {
      value.control.tempo.bpm = CONFIG.tempo.bpmMin - 1;
      value.world.clock.bpm = value.control.tempo.bpm;
    }],
    ['tempo beats', (value) => { value.control.tempo.beatsPerBar = 3; }],
    ['tempo bars', (value) => { value.control.tempo.barsPerDay = 0; }],
    ['active bars', (value) => {
      value.world.trees[0].activeBars = value.control.tempo.barsPerDay + 1;
    }],
  ];
  for (const [label, mutate] of cases) assertInvalid(checkpoint, mutate, label);
});

test('null 只在冻结 nullable/sentinel 字段合法，真实非有限值不能静默修复', () => {
  const checkpoint = createValidCheckpoint();
  assert.equal(validate(checkpoint), true);

  const finiteSentinels = cloneJson(checkpoint);
  finiteSentinels.world.trees[0].birds[0].plannedDwell = 1.25;
  finiteSentinels.world.trees[0].birds[0].plannedFlight = 0;
  finiteSentinels.conductor.cursor.lastDuskShiftDay = 0;
  finiteSentinels.conductor.cursor.lastDuskShiftCycle = 0;
  assert.equal(validate(finiteSentinels), true);

  const cases = [
    ['raw dwell infinity', (value) => {
      value.world.trees[0].birds[0].plannedDwell = Number.POSITIVE_INFINITY;
    }],
    ['raw flight infinity', (value) => {
      value.world.trees[0].birds[0].plannedFlight = Number.POSITIVE_INFINITY;
    }],
    ['raw last dusk -infinity', (value) => {
      value.conductor.cursor.lastDuskShiftDay = Number.NEGATIVE_INFINITY;
    }],
    ['negative dwell', (value) => {
      value.world.trees[0].birds[0].plannedDwell = -1;
    }],
    ['negative finite last dusk', (value) => {
      value.conductor.cursor.lastDuskShiftDay = -1;
    }],
    ['clock null', (value) => { value.world.clock.simTime = null; }],
    ['energy null', (value) => {
      value.world.trees[0].birds[0].energy = null;
    }],
    ['cursor null', (value) => { value.conductor.cursor.seasonIdx = null; }],
    ['settle timer null', (value) => {
      value.world.trees[0].birds[0].settleAt = null;
    }],
  ];
  for (const [label, mutate] of cases) assertInvalid(checkpoint, mutate, label);
});

test('last dusk sentinel 必须是严格的 fresh 或 shifted pair', () => {
  const fresh = createValidCheckpoint();
  assert.equal(validate(fresh), true, 'fresh null/-1 必须合法');
  assert.equal(
    validate(createReachablePostDuskCheckpoint()),
    true,
    'post-dusk numeric/nonnegative 必须合法',
  );

  const corruptions = [
    (value) => {
      value.conductor.cursor.lastDuskShiftDay = null;
      value.conductor.cursor.lastDuskShiftCycle = 0;
    },
    (value) => {
      value.conductor.cursor.lastDuskShiftDay = 1;
      value.conductor.cursor.lastDuskShiftCycle = -1;
    },
  ];
  const outcomes = corruptions.map((corrupt) => {
    const value = cloneJson(fresh);
    corrupt(value);
    return validate(value);
  });
  assert.deepEqual(outcomes, [false, false]);
});

test('provider-free pending 字段必须全为 null', () => {
  const checkpoint = createValidCheckpoint();
  const cases = [
    ['pending plan', (value) => { value.conductor.pendingPlan = {}; }],
    ['pending source', (value) => { value.conductor.pendingSource = 'LLM'; }],
    ['pending reviewed day', (value) => { value.conductor.pendingReviewedDay = 1; }],
  ];
  for (const [label, mutate] of cases) assertInvalid(checkpoint, mutate, label);
});

test('合法 optional/pending alternatives 保持 JSON-safe 且可验证', () => {
  const checkpoint = cloneJson(createValidCheckpoint());
  checkpoint.world.trees[0].birds[0].targetBranch = 0;
  assert.equal(validate(checkpoint), true, 'targetBranch');
  checkpoint.world.trees[0].birds[0].lastBranch = 0;
  assert.equal(validate(checkpoint), true, 'lastBranch');
  const returningBird = checkpoint.world.trees
    .find((tree) => tree.id === 'texture').birds[0];
  returningBird.lastBranch = 0;
  returningBird.returnBranch = 0;
  returningBird.returnCause = 'hop';
  assert.equal(validate(checkpoint), true, 'return metadata');
  returningBird.returnBranch = null;
  returningBird.returnCause = null;
  checkpoint.world.trees[0].birds[0].state = 'perched';
  checkpoint.world.trees[0].birds[0].branchId = 0;
  checkpoint.world.trees[0].birds[0].slotIndex = 0;
  checkpoint.world.trees[0].birds[0].sequenceAddress = {
    pitchBranchId: 0,
    stepIndex: 0,
    stepCount: STEP_COUNT,
  };
  assert.equal(validate(checkpoint), true, 'sequenceAddress');
  checkpoint.world.trees[0].lastSeasonMigrationDay = 1;
  assert.equal(validate(checkpoint), true, 'lastSeasonMigrationDay');
  checkpoint.sequence.bridgePrevious = emptyGrid();
  checkpoint.sequence.reviewedPattern = emptyGrid();
  checkpoint.conductor.patternHistory = [mapTrees(() => emptySummary())];
  assert.equal(validate(checkpoint), true, 'completed bridge');
  checkpoint.conductor.pendingNext = {
    seasonIdx: 1,
    seasonLength: CONFIG.harmony.defaultSeasonLength,
    progressionId: CONFIG.harmony.bySeason[CONFIG.harmony.seasons[1]].progressions[0].id,
  };
  assert.equal(validate(checkpoint), true, 'pendingNext');
  checkpoint.control.agentResumeAt.pad = 1;
  assert.equal(validate(checkpoint), true, 'agentResumeAt');
  checkpoint.control.pendingUserSeasonLength = CONFIG.harmony.defaultSeasonLength;
  assert.equal(validate(checkpoint), true, 'pendingUserSeasonLength');
  checkpoint.conductor.harmonyScoreHistory.pad = [null, 0.7];
  assert.equal(validate(checkpoint), true);
});

test('aggregator 拒绝 paused 注入、额外 part 与 accessor，且不触发 getter', () => {
  const pausedInjection = makeParts();
  pausedInjection.worldState.control.paused = true;
  assertCheckpointError(() => createSimulationCheckpoint(pausedInjection));

  const extraPart = makeParts();
  extraPart.extra = true;
  assertCheckpointError(() => createSimulationCheckpoint(extraPart));

  const accessorPart = makeParts();
  let getterCalls = 0;
  Object.defineProperty(accessorPart, 'worldState', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error('aggregator must inspect descriptor first');
    },
  });
  assertCheckpointError(() => createSimulationCheckpoint(accessorPart));
  assert.equal(getterCalls, 0);

  const proxiedWorldPart = makeParts();
  const worldTarget = proxiedWorldPart.worldState.world;
  let proxyGets = 0;
  proxiedWorldPart.worldState.world = new Proxy(worldTarget, {
    get() {
      proxyGets += 1;
      throw new Error('must not invoke nested proxy get trap');
    },
  });
  const checkpoint = createSimulationCheckpoint(proxiedWorldPart);
  assert.equal(validate(checkpoint), true);
  assert.equal(proxyGets, 0);
});

test('aggregator 将 exportState 的恶意 thrown value 统一为 checkpoint error', () => {
  const parts = makeParts();
  let codeGetterCalls = 0;
  const thrown = {};
  Object.defineProperty(thrown, 'code', {
    get() {
      codeGetterCalls += 1;
      throw new Error('must not read thrown value');
    },
  });
  const throwingRng = () => 0;
  Object.defineProperty(throwingRng, 'exportState', {
    value() {
      throw thrown;
    },
  });
  parts.worldRng = throwingRng;

  assertCheckpointError(() => createSimulationCheckpoint(parts));
  assert.equal(codeGetterCalls, 0);

  const revokedParts = makeParts();
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const revokedThrowingRng = () => 0;
  Object.defineProperty(revokedThrowingRng, 'exportState', {
    value() {
      throw revoked.proxy;
    },
  });
  revokedParts.worldRng = revokedThrowingRng;
  assertCheckpointError(() => createSimulationCheckpoint(revokedParts));
});
