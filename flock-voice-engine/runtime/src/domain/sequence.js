// Sequence v2 pure-data contract.
//
// Axis semantics are deliberately uniform across all four voices:
//   pitchBranchId = vertical pitch (trunk -> higher branches)
//   stepIndex      = time (branch root -> branch tip)
//
// This module has no DOM, Web Audio, renderer, or world mutations. The legacy
// adapter lets the current perch/branchId event stream coexist with the grid
// while renderer/audio/world migrate one boundary at a time.

import { CONFIG } from './config.js';
import { verticalBranchCount } from './mapping.js';

const positiveInteger = (value, fallback) => {
  const number = Math.trunc(Number(value));
  return Number.isInteger(number) && number > 0 ? number : fallback;
};

export function defaultSequenceDimensions(config = CONFIG) {
  const pitchBranchCount = positiveInteger(verticalBranchCount(config), 5);
  const barsPerDay = positiveInteger(config.tempo?.barsPerDay, 4);
  const beatsPerBar = positiveInteger(config.tempo?.beatsPerBar, 4);
  return {
    pitchBranchCount,
    stepCount: barsPerDay * beatsPerBar,
  };
}

export function sequencePlayheadFromPhase(phase, stepCount = defaultSequenceDimensions().stepCount) {
  const count = positiveInteger(stepCount, 1);
  const numericPhase = Number(phase);
  const normalizedPhase = Number.isFinite(numericPhase)
    ? ((numericPhase % 1) + 1) % 1
    : 0;
  const position = normalizedPhase * count;
  const stepIndex = Math.min(count - 1, Math.floor(position));
  return {
    stepIndex,
    stepProgress: position - stepIndex,
    normalizedPhase,
  };
}

// Jungle 使用 Master 双倍 transport；16-step pattern 因而每个项目日循环两次。
// 其它声部与 Texture 模式仍是一日一圈。UI、world 与键盘入口必须共用此函数。
export function sequenceRateForTree(treeId, config = CONFIG) {
  const tree = config.trees?.find((entry) => entry.id === treeId);
  if (tree?.species !== 'texture') return 1;
  const timbre = config.audio?.timbres?.texture;
  return timbre?.mode === 'jungle'
    ? Math.max(1, Number(timbre.jungleTempoMultiplier) || 2)
    : 1;
}

export function sequencePlayheadForTree(
  phase,
  stepCount,
  treeId,
  config = CONFIG,
) {
  return sequencePlayheadFromPhase(
    Number(phase) * sequenceRateForTree(treeId, config),
    stepCount,
  );
}

function emptyVoice(treeId, pitchBranchCount, stepCount) {
  return {
    treeId,
    lanes: Array.from({ length: pitchBranchCount }, (_, pitchBranchId) => ({
      pitchBranchId,
      steps: new Array(stepCount).fill(null),
    })),
  };
}

export function createSequenceGrid({
  treeIds = CONFIG.trees.map((tree) => tree.id),
  pitchBranchCount = defaultSequenceDimensions().pitchBranchCount,
  stepCount = defaultSequenceDimensions().stepCount,
} = {}) {
  const pitches = positiveInteger(pitchBranchCount, 5);
  const steps = positiveInteger(stepCount, 16);
  const ids = [...new Set((Array.isArray(treeIds) ? treeIds : [])
    .map((treeId) => String(treeId ?? '').trim())
    .filter(Boolean))];
  return {
    version: 2,
    pitchBranchCount: pitches,
    stepCount: steps,
    voices: Object.fromEntries(ids.map((treeId) => [treeId, emptyVoice(treeId, pitches, steps)])),
  };
}

function resolveLane(grid, { treeId, pitchBranchId, stepIndex }) {
  const voice = grid?.voices?.[treeId];
  if (!voice) throw new RangeError(`Unknown sequence treeId: ${treeId}`);
  if (!Number.isInteger(pitchBranchId) || pitchBranchId < 0 || pitchBranchId >= grid.pitchBranchCount) {
    throw new RangeError(`Invalid pitchBranchId: ${pitchBranchId}`);
  }
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= grid.stepCount) {
    throw new RangeError(`Invalid stepIndex: ${stepIndex}`);
  }
  return voice.lanes[pitchBranchId];
}

export function getSequenceCell(grid, address) {
  return resolveLane(grid, address).steps[address.stepIndex];
}

// Immutable write: callers can retain the previous day/pattern for evaluator comparisons.
// null clears a cell; any other payload is stored unchanged.
export function setSequenceCell(grid, address, value = true) {
  resolveLane(grid, address);
  const voice = grid.voices[address.treeId];
  const lane = voice.lanes[address.pitchBranchId];
  const steps = lane.steps.slice();
  steps[address.stepIndex] = value;
  const lanes = voice.lanes.slice();
  lanes[address.pitchBranchId] = { ...lane, steps };
  return {
    ...grid,
    voices: {
      ...grid.voices,
      [address.treeId]: { ...voice, lanes },
    },
  };
}

export function activeSequenceCellsAtStep(grid, treeId, stepIndex) {
  const voice = grid?.voices?.[treeId];
  if (!voice || !Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= grid.stepCount) return [];
  return voice.lanes
    .filter((lane) => lane.steps[stepIndex] != null)
    .map((lane) => ({
      treeId,
      pitchBranchId: lane.pitchBranchId,
      stepIndex,
      value: lane.steps[stepIndex],
    }));
}

/**
 * Bridge from legacy `{ treeId, branchId }` events to Sequence v2.
 * All four voices share branchId 0–4 as pitch; time always comes from phase.
 */
export function legacyBranchToSequenceAddress(event, {
  config = CONFIG,
  stepCount = defaultSequenceDimensions(config).stepCount,
} = {}) {
  const treeId = String(event?.treeId ?? '').trim();
  const branchId = Number(event?.branchId);
  const steps = positiveInteger(stepCount, defaultSequenceDimensions(config).stepCount);
  const pitches = defaultSequenceDimensions(config).pitchBranchCount;
  if (!treeId || !Number.isInteger(branchId)) return null;

  if (branchId < 0 || branchId >= pitches) return null;
  return {
    treeId,
    pitchBranchId: branchId,
    stepIndex: sequencePlayheadFromPhase(event?.phase, steps).stepIndex,
  };
}

/**
 * Resolve either a native Sequence v2 event or a legacy world branch event.
 * Native coordinates win as a pair; a missing step may still be derived from
 * phase. This keeps the bridge useful after world starts emitting v2 fields.
 */
export function eventToSequenceAddress(event, options = {}) {
  const config = options.config ?? CONFIG;
  const dimensions = defaultSequenceDimensions(config);
  const stepCount = positiveInteger(options.stepCount, dimensions.stepCount);
  const treeId = String(event?.treeId ?? '').trim();
  const pitchBranchId = Number(event?.pitchBranchId);
  const explicitStep = Number(event?.stepIndex);
  if (treeId && Number.isInteger(pitchBranchId)
    && pitchBranchId >= 0 && pitchBranchId < dimensions.pitchBranchCount) {
    const stepIndex = Number.isInteger(explicitStep)
      ? explicitStep
      : sequencePlayheadFromPhase(event?.phase, stepCount).stepIndex;
    if (stepIndex >= 0 && stepIndex < stepCount) return { treeId, pitchBranchId, stepIndex };
    return null;
  }
  return legacyBranchToSequenceAddress(event, { ...options, config, stepCount });
}

function appendSequenceEvent(grid, address, event) {
  const previous = getSequenceCell(grid, address);
  const entries = Array.isArray(previous) ? previous : [];
  const entry = {
    birdId: event?.birdId ?? null,
    cause: typeof event?.cause === 'string' ? event.cause : null,
    legacyBranchId: Number.isInteger(event?.branchId) ? event.branchId : null,
  };
  return setSequenceCell(grid, address, [...entries, entry]);
}

const SEQUENCE_BRIDGE_STATE_KEYS = ['current', 'previous'];
const SEQUENCE_GRID_KEYS = ['version', 'pitchBranchCount', 'stepCount', 'voices'];
const SEQUENCE_VOICE_KEYS = ['treeId', 'lanes'];
const SEQUENCE_LANE_KEYS = ['pitchBranchId', 'steps'];
const SEQUENCE_EVENT_KEYS = ['birdId', 'cause', 'legacyBranchId'];
const SEQUENCE_EVENT_CAUSES = new Set(['manual', 'settle', 'hop', 'user', 'sequence']);

function sequenceBridgeStateError() {
  const error = new Error('INVALID_SEQUENCE_BRIDGE_STATE');
  error.code = 'INVALID_SEQUENCE_BRIDGE_STATE';
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

function cloneStrictSequenceTree(root) {
  const seen = new WeakSet();

  function visit(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) throw sequenceBridgeStateError();
      return value;
    }
    if (typeof value !== 'object' || seen.has(value)) throw sequenceBridgeStateError();
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
        || ownKeys.length !== lengthDescriptor.value + 1) throw sequenceBridgeStateError();
      const result = new Array(lengthDescriptor.value);
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw sequenceBridgeStateError();
        }
        result[index] = visit(descriptor.value);
      }
      return result;
    }

    if (prototype !== Object.prototype
      || ownKeys.some((key) => typeof key === 'symbol')) throw sequenceBridgeStateError();
    const result = {};
    for (const name of ownKeys) {
      const descriptor = descriptors[name];
      if (!descriptor.enumerable || !('value' in descriptor)) throw sequenceBridgeStateError();
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
    return visit(root);
  } catch {
    throw sequenceBridgeStateError();
  }
}

function sequenceTreeContexts(config) {
  let nextBirdId = 0;
  return config.trees.map((tree) => {
    const firstBirdId = nextBirdId;
    nextBirdId += tree.birdCount;
    const branches = config.species[tree.species]?.allowedBranches
      ?? config.tree.branches.map((branch) => branch.id);
    return {
      tree,
      firstBirdId,
      nextBirdId,
      branches,
    };
  });
}

function validSequenceEvent(entry, context) {
  return exactKeys(entry, SEQUENCE_EVENT_KEYS)
    && (entry.birdId === null || (
      Number.isSafeInteger(entry.birdId)
      && !Object.is(entry.birdId, -0)
      && entry.birdId >= context.firstBirdId
      && entry.birdId < context.nextBirdId
    ))
    && (entry.cause === null || SEQUENCE_EVENT_CAUSES.has(entry.cause))
    && (entry.legacyBranchId === null || (
      Number.isInteger(entry.legacyBranchId)
      && !Object.is(entry.legacyBranchId, -0)
      && context.branches.includes(entry.legacyBranchId)
    ));
}

function validSequenceGrid(grid, dimensions, contexts) {
  const treeIds = contexts.map(({ tree }) => tree.id);
  if (!exactKeys(grid, SEQUENCE_GRID_KEYS)
    || grid.version !== 2
    || grid.pitchBranchCount !== dimensions.pitchBranchCount
    || grid.stepCount !== dimensions.stepCount
    || !exactKeys(grid.voices, treeIds)) return false;

  return contexts.every((context) => {
    const voice = grid.voices[context.tree.id];
    if (!exactKeys(voice, SEQUENCE_VOICE_KEYS)
      || voice.treeId !== context.tree.id
      || !Array.isArray(voice.lanes)
      || voice.lanes.length !== dimensions.pitchBranchCount) return false;
    return voice.lanes.every((lane, pitchBranchId) => (
      exactKeys(lane, SEQUENCE_LANE_KEYS)
      && lane.pitchBranchId === pitchBranchId
      && Array.isArray(lane.steps)
      && lane.steps.length === dimensions.stepCount
      && lane.steps.every((cell) => (
        cell === null
        || (
          Array.isArray(cell)
          && cell.length > 0
          && cell.every((entry) => validSequenceEvent(entry, context))
        )
      ))
    ));
  });
}

function cloneSequenceGrid(grid, dimensions, contexts) {
  const cloned = cloneStrictSequenceTree(grid);
  if (!validSequenceGrid(cloned, dimensions, contexts)) throw sequenceBridgeStateError();
  return cloned;
}

function cloneSequenceBridgeState(restoredState, dimensions, contexts) {
  const cloned = cloneStrictSequenceTree(restoredState);
  if (!exactKeys(cloned, SEQUENCE_BRIDGE_STATE_KEYS)
    || !validSequenceGrid(cloned.current, dimensions, contexts)
    || !(cloned.previous === null
      || validSequenceGrid(cloned.previous, dimensions, contexts))) {
    throw sequenceBridgeStateError();
  }
  return cloned;
}

/**
 * Observational migration bridge: mirrors actual perch onsets into a daily
 * Sequence v2 grid. It never writes to world and preserves multiple birds in
 * one cell. `finishDay()` returns the completed immutable grid and starts an
 * empty one for the next day.
 */
export function createSequencePatternBridge({
  config = CONFIG,
  restoredState = null,
} = {}) {
  const dimensions = defaultSequenceDimensions(config);
  const treeIds = config.trees.map((tree) => tree.id);
  const contexts = sequenceTreeContexts(config);
  const restored = restoredState === null
    ? null
    : cloneSequenceBridgeState(restoredState, dimensions, contexts);
  const freshGrid = () => createSequenceGrid({ treeIds, ...dimensions });
  let current = restored === null ? freshGrid() : restored.current;
  let previous = restored === null ? null : restored.previous;

  return Object.freeze({
    feed(event) {
      const type = event?.event ?? event?.type ?? 'perch';
      if (type !== 'perch') return false;
      const address = eventToSequenceAddress(event, { config, stepCount: current.stepCount });
      if (!address || !current.voices[address.treeId]) return false;
      current = appendSequenceEvent(current, address, event);
      return true;
    },
    finishDay() {
      const completed = cloneSequenceGrid(current, dimensions, contexts);
      previous = current;
      current = freshGrid();
      return completed;
    },
    getCurrent: () => cloneSequenceGrid(current, dimensions, contexts),
    getPrevious: () => (
      previous === null ? null : cloneSequenceGrid(previous, dimensions, contexts)
    ),
    exportDeterministicState() {
      return cloneSequenceBridgeState({ current, previous }, dimensions, contexts);
    },
  });
}

/** Compact, JSON-safe view for Agent review; coordinates retain v2 semantics. */
export function sequencePatternSummary(grid, treeId) {
  const voice = grid?.voices?.[treeId];
  if (!voice) return null;
  const cells = [];
  for (const lane of voice.lanes) {
    lane.steps.forEach((value, stepIndex) => {
      if (value == null) return;
      cells.push({
        pitchBranchId: lane.pitchBranchId,
        stepIndex,
        count: Array.isArray(value) ? value.length : 1,
      });
    });
  }
  return {
    version: 2,
    pitchBranchCount: grid.pitchBranchCount,
    stepCount: grid.stepCount,
    occupiedCells: cells,
  };
}

function validSummaryAddress(summary, address) {
  return Number.isInteger(address?.pitchBranchId)
    && address.pitchBranchId >= 0 && address.pitchBranchId < summary.pitchBranchCount
    && Number.isInteger(address?.stepIndex)
    && address.stepIndex >= 0 && address.stepIndex < summary.stepCount;
}

const addressKey = (address) => `${address.pitchBranchId}:${address.stepIndex}`;

/**
 * Strict, atomic Sequence v2 edit contract.
 * Every edit moves one occupied cell to one previously empty cell in the same
 * voice. Invalid bounds, empty sources, collisions, chains, swaps, or duplicate
 * addresses reject the whole batch. Source counts are preserved.
 */
export function applySequenceCellMutations(summary, mutations, { maxMutations = 2 } = {}) {
  if (!summary || summary.version !== 2
    || !Number.isInteger(summary.pitchBranchCount) || summary.pitchBranchCount < 1
    || !Number.isInteger(summary.stepCount) || summary.stepCount < 1
    || !Array.isArray(summary.occupiedCells) || !Array.isArray(mutations)) return null;
  if (mutations.length > Math.max(0, Math.floor(Number(maxMutations) || 0))) return null;

  const occupied = new Map();
  for (const cell of summary.occupiedCells) {
    if (!validSummaryAddress(summary, cell)) return null;
    const key = addressKey(cell);
    if (occupied.has(key)) return null;
    occupied.set(key, {
      pitchBranchId: cell.pitchBranchId,
      stepIndex: cell.stepIndex,
      count: Math.max(1, Math.floor(Number(cell.count) || 1)),
    });
  }

  const sources = new Set();
  const targets = new Set();
  const normalized = [];
  for (const mutation of mutations) {
    const from = mutation?.from;
    const to = mutation?.to;
    if (!validSummaryAddress(summary, from) || !validSummaryAddress(summary, to)) return null;
    const fromKey = addressKey(from);
    const toKey = addressKey(to);
    if (fromKey === toKey || !occupied.has(fromKey) || occupied.has(toKey)
      || sources.has(fromKey) || targets.has(toKey)
      || targets.has(fromKey) || sources.has(toKey)) return null;
    sources.add(fromKey);
    targets.add(toKey);
    normalized.push({
      from: { pitchBranchId: from.pitchBranchId, stepIndex: from.stepIndex },
      to: { pitchBranchId: to.pitchBranchId, stepIndex: to.stepIndex },
    });
  }

  const next = new Map(occupied);
  normalized.forEach(({ from, to }) => {
    const source = next.get(addressKey(from));
    next.delete(addressKey(from));
    next.set(addressKey(to), { ...to, count: source.count });
  });
  return {
    summary: {
      version: 2,
      pitchBranchCount: summary.pitchBranchCount,
      stepCount: summary.stepCount,
      occupiedCells: [...next.values()].sort(
        (a, b) => a.stepIndex - b.stepIndex || a.pitchBranchId - b.pitchBranchId,
      ),
    },
    mutations: normalized,
  };
}
