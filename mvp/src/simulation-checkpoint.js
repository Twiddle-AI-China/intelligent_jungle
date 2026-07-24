// Provider-free simulation checkpoint 的唯一 wire、验证与聚合入口。

import { CONFIG } from './config.js';
import {
  assertCanonicalSeed,
  createDeterministicRng,
  deriveConductorSeed,
  DETERMINISTIC_RNG_ALGORITHM,
} from './deterministic-rng.js';
import {
  chordFromFrame,
  colorOptions,
  skeletonForSeason,
} from './harmony.js';

export const SIMULATION_CHECKPOINT_SCHEMA_VERSION = 1;
export const SIMULATION_CONFIG_REVISION = 'phase2-domain-config-v1';

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
const PART_KEYS = [
  'worldGeneration',
  'seed',
  'revision',
  'eventSeq',
  'worldState',
  'conductorState',
  'worldRng',
  'conductorRng',
  'paused',
];
const WORLD_STATE_KEYS = ['world', 'sequence', 'control'];
const WORLD_SEQUENCE_KEYS = ['worldPatterns', 'jungleEditPlans', 'lastSequenceStep'];
const WORLD_CONTROL_KEYS = ['treeControl', 'agentResumeAt', 'tempo'];
const CONDUCTOR_STATE_KEYS = ['conductor', 'sequence', 'control'];
const CONDUCTOR_SEQUENCE_KEYS = [
  'bridgeCurrent',
  'bridgePrevious',
  'reviewedPattern',
  'plannedPatterns',
];
const CONDUCTOR_CONTROL_KEYS = ['masterControl', 'pendingUserSeasonLength'];
const WORLD_KEYS = ['clock', 'trees'];
const CLOCK_KEYS = ['simTime', 'day', 'phase', 'bpm', 'dayLength', 'daylight'];
const TREE_KEYS = [
  'id',
  'densityTier',
  'dwellBeats',
  'activeBars',
  'lastSeasonMigrationDay',
  'stats',
  'branchPreference',
  'vocalizeBias',
  'birds',
];
const TREE_STATS_KEYS = [
  'switches',
  'perBirdSwitches',
  'dwellSamples',
  'dwellBeatSamples',
  'silentTime',
  'dayTime',
];
const BIRD_KEYS = [
  'id',
  'treeId',
  'state',
  'branchId',
  'slotIndex',
  'homeBranch',
  'activeToday',
  'mode',
  'targetBranch',
  'settleAt',
  'plannedDwell',
  'plannedFlight',
  'switchesUsed',
  'lastBranch',
  'returnBranch',
  'returnCause',
  'returnSequence',
  'visitCounts',
  'energy',
  'dwellTime',
  'dwellBeatTime',
  'flightTime',
  'orbitRadius',
  'orbitAngle',
  'orbitSpeed',
  'bobPhase',
  'sequenceAddress',
  'pos',
];
const POSITION_KEYS = ['x', 'y'];
const SEQUENCE_ADDRESS_KEYS = ['pitchBranchId', 'stepIndex', 'stepCount'];
const SEQUENCE_KEYS = [
  'worldPatterns',
  'jungleEditPlans',
  'lastSequenceStep',
  'bridgeCurrent',
  'bridgePrevious',
  'reviewedPattern',
  'plannedPatterns',
];
const SUMMARY_KEYS = ['version', 'pitchBranchCount', 'stepCount', 'occupiedCells'];
const SUMMARY_CELL_KEYS = ['pitchBranchId', 'stepIndex', 'count'];
const GRID_KEYS = ['version', 'pitchBranchCount', 'stepCount', 'voices'];
const VOICE_KEYS = ['treeId', 'lanes'];
const LANE_KEYS = ['pitchBranchId', 'steps'];
const GRID_EVENT_KEYS = ['birdId', 'cause', 'legacyBranchId'];
const JUNGLE_PLAN_KEYS = ['breakEdit', 'toneEdit', 'evidence'];
const JUNGLE_EVIDENCE_KEYS = [
  'onsetCount',
  'conflictRatio',
  'patternSimilarity',
  'tension',
];
const CONDUCTOR_KEYS = [
  'cursor',
  'treeScoreHistory',
  'harmonyScoreHistory',
  'pendingNext',
  'currentFrame',
  'currentChord',
  'pendingPlan',
  'pendingSource',
  'pendingReviewedDay',
  'duskColorShiftPlanned',
  'patternHistory',
  'holdState',
  'hCounts',
  'hPerchStart',
];
const CURSOR_KEYS = [
  'seasonIdx',
  'seasonDay',
  'seasonLength',
  'daysSinceChange',
  'currentColorId',
  'daysInColor',
  'progressionId',
  'lastDuskShiftDay',
  'lastDuskShiftCycle',
];
const PENDING_NEXT_KEYS = ['seasonIdx', 'seasonLength', 'progressionId'];
const FRAME_KEYS = [
  'season',
  'seasonDay',
  'seasonLength',
  'progressionStep',
  'progressionCycle',
  'progressionId',
  'period',
  'skeleton',
  'color',
  'tension',
];
const SKELETON_KEYS = ['id', 'root', 'notes'];
const COLOR_KEYS = ['id', 'notes'];
const CHORD_KEYS = [
  'id',
  'notes',
  'melodyNotes',
  'speciesMenus',
  'season',
  'seasonName',
  'skeletonBranches',
  'tension',
  'period',
  'progressionStep',
];
const SPECIES_MENU_KEYS = ['pad', 'bass', 'texture'];
const HOLD_KEYS = ['counter', 'loops', 'generation', 'pitchDirection'];
const H_COUNT_KEYS = ['skeleton', 'color', 'outside'];
const H_PERCH_KEYS = ['birdId', 'treeId', 'key', 'start'];
const RNG_KEYS = ['algorithm', 'world', 'conductor'];
const RNG_STATE_KEYS = ['state', 'drawCount'];
const CONTROL_KEYS = [
  'treeControl',
  'agentResumeAt',
  'tempo',
  'masterControl',
  'pendingUserSeasonLength',
  'paused',
];
const TEMPO_KEYS = ['bpm', 'barsPerDay', 'beatsPerBar'];
const EXPECTED_KEYS = ['seed', 'configRevision'];
const WORLD_STATES = new Set(['flying', 'perched']);
const BIRD_MODES = new Set(['settle', 'day', 'free', 'sequence']);
const EVENT_CAUSES = new Set(['manual', 'settle', 'hop', 'user', 'sequence']);
const RETURN_CAUSES = new Set(['settle', 'hop', 'user', 'sequence']);
const TREE_CONTROLS = new Set(['AGENT', 'USER']);
const PERIODS = new Set(['day', 'night']);
const HARMONY_CLASSES = new Set(['skeleton', 'color', 'outside']);
const BREAK_EDITS = new Set(['hold', 'repeat2', 'repeat4', 'dropout']);
const TONE_EDITS = new Set(['clean', 'dub', 'filter', 'crush', 'reverse']);
const HARMONY_PROGRESSION_DAYS = 4;

function checkpointError() {
  const error = new Error('INVALID_SIMULATION_CHECKPOINT');
  error.code = 'INVALID_SIMULATION_CHECKPOINT';
  return error;
}

function sorted(values) {
  return [...values].sort();
}

function exactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = sorted(Object.keys(value));
  const expected = sorted(expectedKeys);
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function jsonEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null
    || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]));
  }
  const leftKeys = sorted(Object.keys(left));
  const rightKeys = sorted(Object.keys(right));
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && jsonEqual(left[key], right[key])
    ));
}

function cloneStrictJsonTree(root) {
  const seen = new WeakSet();

  function visit(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) throw checkpointError();
      return value;
    }
    if (typeof value !== 'object') throw checkpointError();
    if (seen.has(value)) throw checkpointError();
    seen.add(value);

    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      const lengthDescriptor = descriptors.length;
      if (prototype !== Array.prototype
        || ownKeys.some((key) => typeof key === 'symbol')
        || !lengthDescriptor
        || !('value' in lengthDescriptor)
        || lengthDescriptor.enumerable
        || !Number.isInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || ownKeys.length !== lengthDescriptor.value + 1) throw checkpointError();
      const result = new Array(lengthDescriptor.value);
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !('value' in descriptor)) throw checkpointError();
        result[index] = visit(descriptor.value);
      }
      return result;
    }

    if (prototype !== Object.prototype
      || ownKeys.some((key) => typeof key === 'symbol')) throw checkpointError();
    const result = {};
    for (const name of ownKeys) {
      const descriptor = descriptors[name];
      if (!descriptor.enumerable || !('value' in descriptor)) throw checkpointError();
      Object.defineProperty(result, name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: visit(descriptor.value),
      });
    }
    return result;
  }

  try {
    return { ok: true, value: visit(root) };
  } catch {
    return { ok: false, value: null };
  }
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteInRange(value, minimum, maximum) {
  return finite(value) && value >= minimum && value <= maximum;
}

function nonNegativeFinite(value) {
  return finite(value) && value >= 0;
}

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function safePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function uint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
    && !Object.is(value, -0);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactTreeMap(value, validateValue) {
  const treeIds = CONFIG.trees.map((tree) => tree.id);
  if (!exactKeys(value, treeIds)) return false;
  return CONFIG.trees.every((tree, index) => validateValue(value[tree.id], tree, index));
}

function finiteArray(value, { minimum = -Infinity, maximum = Infinity, nonEmpty = false } = {}) {
  return Array.isArray(value)
    && (!nonEmpty || value.length > 0)
    && value.every((entry) => finiteInRange(entry, minimum, maximum));
}

function allowedBranches(treeConfig) {
  return CONFIG.species[treeConfig.species].allowedBranches
    ?? CONFIG.tree.branches.map((branch) => branch.id);
}

function validBranch(value, treeConfig) {
  return Number.isInteger(value) && allowedBranches(treeConfig).includes(value);
}

function nullableBranch(value, treeConfig) {
  return value === null || validBranch(value, treeConfig);
}

function validPlannedTimer(value) {
  return value === null || nonNegativeFinite(value);
}

function validateSequenceAddress(value, treeConfig) {
  return value === null || (
    exactKeys(value, SEQUENCE_ADDRESS_KEYS)
    && validBranch(value.pitchBranchId, treeConfig)
    && Number.isInteger(value.stepCount)
    && value.stepCount >= 1
    && value.stepCount <= 64
    && Number.isInteger(value.stepIndex)
    && value.stepIndex >= 0
    && value.stepIndex < value.stepCount
  );
}

function validateTreeStats(stats, birds) {
  if (!exactKeys(stats, TREE_STATS_KEYS)
    || !safeNonNegativeInteger(stats.switches)
    || !exactKeys(stats.perBirdSwitches, Object.keys(stats.perBirdSwitches))
    || !finiteArray(stats.dwellSamples, { minimum: 0 })
    || !finiteArray(stats.dwellBeatSamples, { minimum: 0 })
    || stats.dwellSamples.length !== stats.dwellBeatSamples.length
    || !nonNegativeFinite(stats.silentTime)
    || !nonNegativeFinite(stats.dayTime)
    || stats.silentTime > stats.dayTime) return false;
  const allowedIds = new Set(birds.map((bird) => bird.id));
  let switchTotal = 0;
  const validPerBirdSwitches = Object.entries(stats.perBirdSwitches).every(([birdId, count]) => {
    const parsed = Number(birdId);
    if (String(parsed) !== birdId
      || !allowedIds.has(parsed)
      || !safeNonNegativeInteger(count)) return false;
    switchTotal += count;
    return true;
  });
  return validPerBirdSwitches
    && switchTotal === stats.switches
    && birds.every((bird) => (
      (stats.perBirdSwitches[String(bird.id)] ?? 0) === bird.switchesUsed
    ));
}

function validateBird(bird, treeConfig, expectedId) {
  if (!exactKeys(bird, BIRD_KEYS)
    || bird.id !== expectedId
    || bird.treeId !== treeConfig.id
    || !WORLD_STATES.has(bird.state)
    || !nullableBranch(bird.branchId, treeConfig)
    || !(bird.slotIndex === null || (
      Number.isInteger(bird.slotIndex)
      && bird.slotIndex >= 0
      && bird.slotIndex < CONFIG.tree.perchSlotsPerBranch
    ))
    || !validBranch(bird.homeBranch, treeConfig)
    || typeof bird.activeToday !== 'boolean'
    || !BIRD_MODES.has(bird.mode)
    || !nullableBranch(bird.targetBranch, treeConfig)
    || !nonNegativeFinite(bird.settleAt)
    || !validPlannedTimer(bird.plannedDwell)
    || !validPlannedTimer(bird.plannedFlight)
    || !safeNonNegativeInteger(bird.switchesUsed)
    || bird.switchesUsed > CONFIG.species[treeConfig.species].switchQuota
    || !nullableBranch(bird.lastBranch, treeConfig)
    || !nullableBranch(bird.returnBranch, treeConfig)
    || !(bird.returnCause === null || RETURN_CAUSES.has(bird.returnCause))
    || !safeNonNegativeInteger(bird.returnSequence)
    || !Array.isArray(bird.visitCounts)
    || bird.visitCounts.length !== CONFIG.tree.branches.length
    || !bird.visitCounts.every(safeNonNegativeInteger)
    || !finiteInRange(bird.energy, 0, 1)
    || !nonNegativeFinite(bird.dwellTime)
    || !nonNegativeFinite(bird.dwellBeatTime)
    || !nonNegativeFinite(bird.flightTime)
    || !nonNegativeFinite(bird.orbitRadius)
    || !finite(bird.orbitAngle)
    || !finite(bird.orbitSpeed)
    || !finite(bird.bobPhase)
    || !validateSequenceAddress(bird.sequenceAddress, treeConfig)
    || !exactKeys(bird.pos, POSITION_KEYS)
    || !finite(bird.pos.x)
    || !finite(bird.pos.y)) return false;

  if (bird.state === 'flying') {
    const hasReturnMetadata = bird.returnBranch !== null && bird.returnCause !== null;
    return bird.branchId === null
      && bird.slotIndex === null
      && bird.sequenceAddress === null
      && (bird.returnBranch === null) === (bird.returnCause === null)
      && (!hasReturnMetadata
        || (
          CONFIG.species[treeConfig.species].returnBranchProbability > 0
          && bird.returnBranch === bird.lastBranch
        ));
  }
  return bird.branchId !== null
    && bird.slotIndex !== null
    && bird.sequenceAddress !== null
    && bird.sequenceAddress.pitchBranchId === bird.branchId
    && bird.returnBranch === null
    && bird.returnCause === null;
}

function validateWorld(world, tempo) {
  if (!exactKeys(world, WORLD_KEYS) || !exactKeys(world.clock, CLOCK_KEYS)) return null;
  const clock = world.clock;
  const expectedDayLength = tempo.barsPerDay * tempo.beatsPerBar * 60 / tempo.bpm;
  if (!nonNegativeFinite(clock.simTime)
    || !safePositiveInteger(clock.day)
    || !finiteInRange(clock.phase, 0, 1)
    || clock.phase >= 1
    || clock.bpm !== tempo.bpm
    || !finite(clock.dayLength)
    || Math.abs(clock.dayLength - expectedDayLength) > 1e-12
    || !finiteInRange(clock.daylight, 0, 1)
    || !Array.isArray(world.trees)
    || world.trees.length !== CONFIG.trees.length) return null;

  const birdsById = new Map();
  let expectedBirdId = 0;
  for (let treeIndex = 0; treeIndex < CONFIG.trees.length; treeIndex += 1) {
    const treeConfig = CONFIG.trees[treeIndex];
    const tree = world.trees[treeIndex];
    if (!exactKeys(tree, TREE_KEYS)
      || tree.id !== treeConfig.id
      || !Object.hasOwn(CONFIG.agent.densityTiers, tree.densityTier)
      || !finite(tree.dwellBeats)
      || tree.dwellBeats <= 0
      || !finiteInRange(tree.activeBars, 0, tempo.barsPerDay)
      || !(tree.lastSeasonMigrationDay === null
        || safePositiveInteger(tree.lastSeasonMigrationDay))
      || !Array.isArray(tree.branchPreference)
      || tree.branchPreference.length !== CONFIG.tree.branches.length
      || !tree.branchPreference.every((weight) => finiteInRange(weight, 0, 1))
      || !finiteInRange(tree.vocalizeBias, 0, 1)
      || !Array.isArray(tree.birds)
      || tree.birds.length !== treeConfig.birdCount) return null;

    for (const bird of tree.birds) {
      if (!validateBird(bird, treeConfig, expectedBirdId)) {
        return null;
      }
      birdsById.set(expectedBirdId, { treeId: treeConfig.id, bird });
      expectedBirdId += 1;
    }
    if (!validateTreeStats(tree.stats, tree.birds)) return null;
  }
  return { clock, birdsById };
}

function validateSummary(summary, treeConfig, stepCount, nullable = true) {
  if (summary === null) return nullable;
  if (!exactKeys(summary, SUMMARY_KEYS)
    || summary.version !== 2
    || summary.pitchBranchCount !== CONFIG.tree.branches.length
    || summary.stepCount !== stepCount
    || !Array.isArray(summary.occupiedCells)) return false;
  const seen = new Set();
  for (const cell of summary.occupiedCells) {
    if (!exactKeys(cell, SUMMARY_CELL_KEYS)
      || !validBranch(cell.pitchBranchId, treeConfig)
      || !Number.isInteger(cell.stepIndex)
      || cell.stepIndex < 0
      || cell.stepIndex >= stepCount
      || !safePositiveInteger(cell.count)
      || cell.count > treeConfig.birdCount) return false;
    const key = `${cell.pitchBranchId}:${cell.stepIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function validateWorldSummary(summary, treeConfig) {
  if (summary === null) return true;
  if (!exactKeys(summary, SUMMARY_KEYS)
    || summary.version !== 2
    || !Number.isInteger(summary.pitchBranchCount)
    || summary.pitchBranchCount < 1
    || summary.pitchBranchCount > CONFIG.tree.branches.length
    || !Number.isInteger(summary.stepCount)
    || summary.stepCount < 1
    || summary.stepCount > 64
    || !Array.isArray(summary.occupiedCells)) return false;
  const seen = new Set();
  for (const cell of summary.occupiedCells) {
    if (!exactKeys(cell, SUMMARY_CELL_KEYS)
      || !Number.isInteger(cell.pitchBranchId)
      || cell.pitchBranchId < 0
      || cell.pitchBranchId >= summary.pitchBranchCount
      || !Number.isInteger(cell.stepIndex)
      || cell.stepIndex < 0
      || cell.stepIndex >= summary.stepCount
      || !safePositiveInteger(cell.count)
      || cell.count > treeConfig.birdCount) return false;
    const key = `${cell.pitchBranchId}:${cell.stepIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function validateGridEvent(entry, treeConfig, birdsById) {
  return exactKeys(entry, GRID_EVENT_KEYS)
    && (entry.birdId === null || (
      safeNonNegativeInteger(entry.birdId)
      && birdsById.get(entry.birdId)?.treeId === treeConfig.id
    ))
    && (entry.cause === null || EVENT_CAUSES.has(entry.cause))
    && (entry.legacyBranchId === null || validBranch(entry.legacyBranchId, treeConfig));
}

function validateGrid(grid, stepCount, birdsById, nullable = false) {
  if (grid === null) return nullable;
  if (!exactKeys(grid, GRID_KEYS)
    || grid.version !== 2
    || grid.pitchBranchCount !== CONFIG.tree.branches.length
    || grid.stepCount !== stepCount
    || !exactTreeMap(grid.voices, (voice, treeConfig) => {
      if (!exactKeys(voice, VOICE_KEYS)
        || voice.treeId !== treeConfig.id
        || !Array.isArray(voice.lanes)
        || voice.lanes.length !== CONFIG.tree.branches.length) return false;
      return voice.lanes.every((lane, pitchBranchId) => (
        exactKeys(lane, LANE_KEYS)
        && lane.pitchBranchId === pitchBranchId
        && Array.isArray(lane.steps)
        && lane.steps.length === stepCount
        && lane.steps.every((cell) => (
          cell === null
          || (
            Array.isArray(cell)
            && cell.length > 0
            && cell.every((entry) => validateGridEvent(entry, treeConfig, birdsById))
          )
        ))
      ));
    })) return false;
  return true;
}

function validateJunglePlan(plan) {
  return plan === null || (
    exactKeys(plan, JUNGLE_PLAN_KEYS)
    && BREAK_EDITS.has(plan.breakEdit)
    && TONE_EDITS.has(plan.toneEdit)
    && exactKeys(plan.evidence, JUNGLE_EVIDENCE_KEYS)
    && nonNegativeFinite(plan.evidence.onsetCount)
    && finiteInRange(plan.evidence.conflictRatio, 0, 1)
    && finiteInRange(plan.evidence.patternSimilarity, 0, 1)
    && finiteInRange(plan.evidence.tension, 0, 1)
  );
}

function validateSequence(sequence, tempo, birdsById) {
  if (!exactKeys(sequence, SEQUENCE_KEYS)) return false;
  const stepCount = tempo.barsPerDay * tempo.beatsPerBar;
  if (!exactTreeMap(sequence.worldPatterns, (summary, treeConfig) => (
    validateWorldSummary(summary, treeConfig)
  ))) return false;
  if (!exactTreeMap(sequence.jungleEditPlans, (plan) => validateJunglePlan(plan))) return false;
  if (!exactTreeMap(sequence.lastSequenceStep, (step, treeConfig) => {
    const pattern = sequence.worldPatterns[treeConfig.id];
    if (step === null) return true;
    return pattern !== null
      && Number.isInteger(step)
      && step >= 0
      && step < pattern.stepCount;
  })) return false;
  if (!validateGrid(sequence.bridgeCurrent, stepCount, birdsById)
    || !validateGrid(sequence.bridgePrevious, stepCount, birdsById, true)
    || !validateGrid(sequence.reviewedPattern, stepCount, birdsById, true)
    || !exactTreeMap(sequence.plannedPatterns, (summary, treeConfig) => (
      validateSummary(summary, treeConfig, stepCount)
    ))) return false;
  return true;
}

function validateFrame(frame, cursor) {
  if (!exactKeys(frame, FRAME_KEYS)
    || frame.season !== CONFIG.harmony.seasons[cursor.seasonIdx]
    || frame.seasonDay !== cursor.seasonDay
    || frame.seasonLength !== cursor.seasonLength
    || !safeNonNegativeInteger(frame.progressionStep)
    || !safeNonNegativeInteger(frame.progressionCycle)
    || frame.progressionId !== cursor.progressionId
    || !PERIODS.has(frame.period)
    || !exactKeys(frame.skeleton, SKELETON_KEYS)
    || !nonEmptyString(frame.skeleton.id)
    || !finite(frame.skeleton.root)
    || !finiteArray(frame.skeleton.notes, { nonEmpty: true })
    || frame.skeleton.notes.length !== CONFIG.tree.branches.length
    || !exactKeys(frame.color, COLOR_KEYS)
    || !nonEmptyString(frame.color.id)
    || !finiteArray(frame.color.notes, { nonEmpty: true })
    || frame.color.notes.length
      !== CONFIG.tree.branches.length - CONFIG.harmony.skeletonBranches
    || !finiteInRange(
      frame.tension,
      CONFIG.harmony.tensionRange[0],
      CONFIG.harmony.tensionRange[1],
    )) return false;
  const expectedSkeleton = skeletonForSeason(
    frame.season,
    CONFIG.harmony,
    cursor.seasonDay,
    cursor.progressionId,
  );
  const allowedColors = colorOptions(
    frame.season,
    CONFIG.harmony,
    cursor.seasonDay,
    frame.period,
    cursor.progressionId,
  );
  return frame.progressionStep === cursor.seasonDay % HARMONY_PROGRESSION_DAYS
    && frame.progressionCycle
      === Math.floor(cursor.seasonDay / HARMONY_PROGRESSION_DAYS)
    && jsonEqual(frame.skeleton, expectedSkeleton)
    && allowedColors.some((color) => jsonEqual(frame.color, color));
}

function validateChord(chord, frame) {
  return exactKeys(chord, CHORD_KEYS)
    && nonEmptyString(chord.id)
    && finiteArray(chord.notes, { nonEmpty: true })
    && chord.notes.length === CONFIG.tree.branches.length
    && finiteArray(chord.melodyNotes, { nonEmpty: true })
    && exactKeys(chord.speciesMenus, SPECIES_MENU_KEYS)
    && SPECIES_MENU_KEYS.every((key) => finiteArray(
      chord.speciesMenus[key],
      { nonEmpty: true },
    ))
    && chord.season === frame.season
    && nonEmptyString(chord.seasonName)
    && chord.skeletonBranches === CONFIG.harmony.skeletonBranches
    && chord.tension === frame.tension
    && chord.period === frame.period
    && chord.progressionStep === frame.progressionStep
    && jsonEqual(chord, chordFromFrame(frame, CONFIG.harmony));
}

function validProgressionId(seasonIdx, progressionId) {
  const season = CONFIG.harmony.seasons[seasonIdx];
  return nonEmptyString(progressionId)
    && (CONFIG.harmony.bySeason[season]?.progressions ?? [])
      .some((progression) => progression.id === progressionId);
}

function validateCursor(cursor) {
  const [minimumSeasonLength, maximumSeasonLength] = CONFIG.llm.seasonLengthRange;
  if (!exactKeys(cursor, CURSOR_KEYS)
    || !Number.isInteger(cursor.seasonIdx)
    || cursor.seasonIdx < 0
    || cursor.seasonIdx >= CONFIG.harmony.seasons.length
    || !safeNonNegativeInteger(cursor.seasonDay)
    || !safePositiveInteger(cursor.seasonLength)
    || cursor.seasonLength < minimumSeasonLength
    || cursor.seasonLength > maximumSeasonLength
    || cursor.seasonDay >= cursor.seasonLength
    || !safeNonNegativeInteger(cursor.daysSinceChange)
    || !nonEmptyString(cursor.currentColorId)
    || !safePositiveInteger(cursor.daysInColor)
    || !validProgressionId(cursor.seasonIdx, cursor.progressionId)
    || !(cursor.lastDuskShiftDay === null
      || safeNonNegativeInteger(cursor.lastDuskShiftDay))
    || !Number.isSafeInteger(cursor.lastDuskShiftCycle)
    || cursor.lastDuskShiftCycle < -1
    || !(
      (cursor.lastDuskShiftDay === null && cursor.lastDuskShiftCycle === -1)
      || (
        safeNonNegativeInteger(cursor.lastDuskShiftDay)
        && safeNonNegativeInteger(cursor.lastDuskShiftCycle)
      )
    )) return false;
  return true;
}

function validatePendingNext(pendingNext) {
  if (pendingNext === null) return true;
  return exactKeys(pendingNext, PENDING_NEXT_KEYS)
    && Number.isInteger(pendingNext.seasonIdx)
    && pendingNext.seasonIdx >= 0
    && pendingNext.seasonIdx < CONFIG.harmony.seasons.length
    && safePositiveInteger(pendingNext.seasonLength)
    && pendingNext.seasonLength >= CONFIG.llm.seasonLengthRange[0]
    && pendingNext.seasonLength <= CONFIG.llm.seasonLengthRange[1]
    && validProgressionId(pendingNext.seasonIdx, pendingNext.progressionId);
}

function validateScoreHistories(histories, nullableValues) {
  return exactTreeMap(histories, (history) => (
    Array.isArray(history)
    && history.length <= 3
    && history.every((score) => (
      (nullableValues && score === null)
      || finiteInRange(score, 0, 1)
    ))
  ));
}

function validatePatternHistory(history, stepCount) {
  return Array.isArray(history) && history.every((pattern) => (
    exactTreeMap(pattern, (summary, treeConfig) => (
      validateSummary(summary, treeConfig, stepCount, false)
    ))
  ));
}

function summarizeGrid(grid) {
  return Object.fromEntries(CONFIG.trees.map((tree) => {
    const occupiedCells = [];
    for (const lane of grid.voices[tree.id].lanes) {
      lane.steps.forEach((cell, stepIndex) => {
        if (cell !== null) {
          occupiedCells.push({
            pitchBranchId: lane.pitchBranchId,
            stepIndex,
            count: cell.length,
          });
        }
      });
    }
    return [tree.id, {
      version: grid.version,
      pitchBranchCount: grid.pitchBranchCount,
      stepCount: grid.stepCount,
      occupiedCells,
    }];
  }));
}

function validateSequenceReviewState(sequence, patternHistory) {
  const previousIsNull = sequence.bridgePrevious === null;
  const reviewedIsNull = sequence.reviewedPattern === null;
  if (previousIsNull !== reviewedIsNull) return false;
  if (previousIsNull) return patternHistory.length === 0;
  return patternHistory.length > 0
    && jsonEqual(sequence.bridgePrevious, sequence.reviewedPattern)
    && jsonEqual(
      patternHistory[patternHistory.length - 1],
      summarizeGrid(sequence.reviewedPattern),
    );
}

function validateHoldState(holdState) {
  const [minimumLoops, maximumLoops] = CONFIG.agent.holdLoopsRange;
  return exactTreeMap(holdState, (hold) => (
    exactKeys(hold, HOLD_KEYS)
    && safeNonNegativeInteger(hold.counter)
    && safePositiveInteger(hold.loops)
    && hold.loops >= minimumLoops
    && hold.loops <= maximumLoops
    && hold.counter <= hold.loops
    && safeNonNegativeInteger(hold.generation)
    && (hold.pitchDirection === -1 || hold.pitchDirection === 1)
  ));
}

function validateHarmonyState(conductor, birdsById, clock) {
  if (!exactTreeMap(conductor.hCounts, (counts) => (
    exactKeys(counts, H_COUNT_KEYS)
    && nonNegativeFinite(counts.skeleton)
    && nonNegativeFinite(counts.color)
    && nonNegativeFinite(counts.outside)
  )) || !Array.isArray(conductor.hPerchStart)) return false;

  const seenBirds = new Set();
  for (const record of conductor.hPerchStart) {
    const birdRecord = birdsById.get(record.birdId);
    if (!exactKeys(record, H_PERCH_KEYS)
      || !safeNonNegativeInteger(record.birdId)
      || seenBirds.has(record.birdId)
      || birdRecord?.treeId !== record.treeId
      || birdRecord.bird.state !== 'perched'
      || record.key !== (
        birdRecord.bird.branchId < CONFIG.harmony.skeletonBranches
          ? 'skeleton'
          : 'color'
      )
      || !HARMONY_CLASSES.has(record.key)
      || !nonNegativeFinite(record.start)
      || record.start > clock.simTime) return false;
    seenBirds.add(record.birdId);
  }
  return true;
}

function validateFrameColorState(conductor, clock) {
  const { cursor, currentFrame: frame } = conductor;
  if (frame.period === 'day') {
    return cursor.currentColorId === frame.color.id;
  }
  if (frame.period !== 'night'
    || conductor.duskColorShiftPlanned !== false
    || clock.phase < CONFIG.sim.duskPhase
    || cursor.lastDuskShiftDay !== clock.day
    || cursor.lastDuskShiftCycle
      !== Math.floor(cursor.seasonDay / HARMONY_PROGRESSION_DAYS)) return false;

  const dayColors = colorOptions(
    frame.season,
    CONFIG.harmony,
    cursor.seasonDay,
    'day',
    cursor.progressionId,
  );
  const dayColorIndex = dayColors.findIndex(
    (color) => color.id === cursor.currentColorId,
  );
  if (dayColorIndex < 0 || dayColors.length === 0) return false;
  const nightColors = colorOptions(
    frame.season,
    CONFIG.harmony,
    cursor.seasonDay,
    'night',
    cursor.progressionId,
  );
  const successorIndex = (dayColorIndex + 1) % dayColors.length;
  return jsonEqual(frame.color, nightColors[successorIndex]);
}

function validateConductor(conductor, sequence, tempo, birdsById, clock) {
  if (!exactKeys(conductor, CONDUCTOR_KEYS)
    || !validateCursor(conductor.cursor)
    || !validateScoreHistories(conductor.treeScoreHistory, false)
    || !validateScoreHistories(conductor.harmonyScoreHistory, true)
    || !validatePendingNext(conductor.pendingNext)
    || !validateFrame(conductor.currentFrame, conductor.cursor)
    || !validateFrameColorState(conductor, clock)
    || !validateChord(conductor.currentChord, conductor.currentFrame)
    || conductor.pendingPlan !== null
    || conductor.pendingSource !== null
    || conductor.pendingReviewedDay !== null
    || typeof conductor.duskColorShiftPlanned !== 'boolean'
    || !validatePatternHistory(
      conductor.patternHistory,
      tempo.barsPerDay * tempo.beatsPerBar,
    )
    || !validateSequenceReviewState(sequence, conductor.patternHistory)
    || !validateHoldState(conductor.holdState)
    || !validateHarmonyState(conductor, birdsById, clock)) return false;
  return true;
}

function validateTempo(tempo) {
  const configuredSteps = CONFIG.tempo.barsPerDay * CONFIG.tempo.beatsPerBar;
  return exactKeys(tempo, TEMPO_KEYS)
    && finiteInRange(tempo.bpm, CONFIG.tempo.bpmMin, CONFIG.tempo.bpmMax)
    && finite(tempo.barsPerDay)
    && tempo.barsPerDay > 0
    && [2, 4, 8].includes(tempo.beatsPerBar)
    && tempo.barsPerDay * tempo.beatsPerBar === configuredSteps;
}

function validateControl(control) {
  if (!exactKeys(control, CONTROL_KEYS)
    || !validateTempo(control.tempo)
    || !exactTreeMap(control.treeControl, (mode) => TREE_CONTROLS.has(mode))
    || !exactTreeMap(control.agentResumeAt, (resumeAt) => (
      resumeAt === null || nonNegativeFinite(resumeAt)
    ))
    || !CONFIG.trees.every((tree) => (
      control.treeControl[tree.id] !== 'USER'
      || control.agentResumeAt[tree.id] === null
    ))
    || !TREE_CONTROLS.has(control.masterControl)
    || !(control.pendingUserSeasonLength === null || (
      safePositiveInteger(control.pendingUserSeasonLength)
      && control.pendingUserSeasonLength >= CONFIG.llm.seasonLengthRange[0]
      && control.pendingUserSeasonLength <= CONFIG.llm.seasonLengthRange[1]
    ))
    || typeof control.paused !== 'boolean') return false;
  return true;
}

function validateRngState(state, seed) {
  if (!exactKeys(state, RNG_STATE_KEYS) || !uint32(state.state)
    || !safeNonNegativeInteger(state.drawCount)) return false;
  try {
    createDeterministicRng(seed, state);
    return true;
  } catch {
    return false;
  }
}

function validateRng(rng, seed) {
  return exactKeys(rng, RNG_KEYS)
    && rng.algorithm === DETERMINISTIC_RNG_ALGORITHM
    && validateRngState(rng.world, seed)
    && validateRngState(rng.conductor, deriveConductorSeed(seed));
}

function validateCheckpointData(checkpoint, expected) {
  if (!exactKeys(checkpoint, TOP_LEVEL_KEYS)
    || !exactKeys(expected, EXPECTED_KEYS)) return false;

  let expectedSeed;
  try {
    expectedSeed = assertCanonicalSeed(expected.seed);
  } catch {
    return false;
  }
  if (expected.configRevision !== SIMULATION_CONFIG_REVISION
    || checkpoint.worldId !== 'default'
    || checkpoint.protocolVersion !== 1
    || checkpoint.snapshotSchemaVersion !== 1
    || checkpoint.schemaVersion !== SIMULATION_CHECKPOINT_SCHEMA_VERSION
    || checkpoint.configRevision !== expected.configRevision
    || checkpoint.seed !== expectedSeed
    || !nonEmptyString(checkpoint.worldGeneration)
    || !safeNonNegativeInteger(checkpoint.revision)
    || !safeNonNegativeInteger(checkpoint.eventSeq)
    || !validateControl(checkpoint.control)) return false;

  const worldContext = validateWorld(checkpoint.world, checkpoint.control.tempo);
  if (!worldContext
    || !validateSequence(
      checkpoint.sequence,
      checkpoint.control.tempo,
      worldContext.birdsById,
    )
    || !validateConductor(
      checkpoint.conductor,
      checkpoint.sequence,
      checkpoint.control.tempo,
      worldContext.birdsById,
      worldContext.clock,
    )
    || !validateRng(checkpoint.rng, expectedSeed)) return false;
  return true;
}

function prepareCheckpoint(checkpoint, expected) {
  const checkpointTree = cloneStrictJsonTree(checkpoint);
  const expectedTree = cloneStrictJsonTree(expected);
  if (!checkpointTree.ok || !expectedTree.ok
    || !validateCheckpointData(checkpointTree.value, expectedTree.value)) return null;
  return checkpointTree.value;
}

export function validateSimulationCheckpoint(checkpoint, expected) {
  try {
    return prepareCheckpoint(checkpoint, expected) !== null;
  } catch {
    return false;
  }
}

function readDataRecord(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return null;
  const names = sorted(Object.getOwnPropertyNames(value));
  const expected = sorted(expectedKeys);
  if (names.length !== expected.length
    || names.some((name, index) => name !== expected[index])) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = {};
  for (const name of expectedKeys) {
    const descriptor = descriptors[name];
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    result[name] = descriptor.value;
  }
  return result;
}

function exportRngState(rng) {
  if (typeof rng !== 'function') return null;
  const descriptor = Object.getOwnPropertyDescriptor(rng, 'exportState');
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return null;
  return descriptor.value.call(rng);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createSimulationCheckpoint(parts) {
  try {
    const input = readDataRecord(parts, PART_KEYS);
    if (!input) throw checkpointError();
    const worldState = readDataRecord(input.worldState, WORLD_STATE_KEYS);
    const conductorState = readDataRecord(input.conductorState, CONDUCTOR_STATE_KEYS);
    if (!worldState || !conductorState) throw checkpointError();
    const worldSequence = readDataRecord(worldState.sequence, WORLD_SEQUENCE_KEYS);
    const worldControl = readDataRecord(worldState.control, WORLD_CONTROL_KEYS);
    const conductorSequence = readDataRecord(
      conductorState.sequence,
      CONDUCTOR_SEQUENCE_KEYS,
    );
    const conductorControl = readDataRecord(
      conductorState.control,
      CONDUCTOR_CONTROL_KEYS,
    );
    if (!worldSequence || !worldControl || !conductorSequence || !conductorControl) {
      throw checkpointError();
    }

    const control = {
      treeControl: worldControl.treeControl,
      agentResumeAt: worldControl.agentResumeAt,
      tempo: worldControl.tempo,
      masterControl: conductorControl.masterControl,
      pendingUserSeasonLength: conductorControl.pendingUserSeasonLength,
    };
    control.paused = input.paused;

    const checkpoint = {
      worldId: 'default',
      protocolVersion: 1,
      snapshotSchemaVersion: 1,
      schemaVersion: SIMULATION_CHECKPOINT_SCHEMA_VERSION,
      configRevision: SIMULATION_CONFIG_REVISION,
      worldGeneration: input.worldGeneration,
      seed: input.seed,
      revision: input.revision,
      eventSeq: input.eventSeq,
      world: worldState.world,
      sequence: {
        worldPatterns: worldSequence.worldPatterns,
        jungleEditPlans: worldSequence.jungleEditPlans,
        lastSequenceStep: worldSequence.lastSequenceStep,
        bridgeCurrent: conductorSequence.bridgeCurrent,
        bridgePrevious: conductorSequence.bridgePrevious,
        reviewedPattern: conductorSequence.reviewedPattern,
        plannedPatterns: conductorSequence.plannedPatterns,
      },
      conductor: conductorState.conductor,
      rng: {
        algorithm: DETERMINISTIC_RNG_ALGORITHM,
        world: exportRngState(input.worldRng),
        conductor: exportRngState(input.conductorRng),
      },
      control,
    };

    const prepared = prepareCheckpoint(checkpoint, {
      seed: input.seed,
      configRevision: SIMULATION_CONFIG_REVISION,
    });
    if (!prepared) throw checkpointError();
    return deepFreeze(structuredClone(prepared));
  } catch {
    throw checkpointError();
  }
}
