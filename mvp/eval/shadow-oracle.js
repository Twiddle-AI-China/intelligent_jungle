import { CONFIG } from '../src/config.js';
import { createDeterministicConductor } from '../src/deterministic-conductor.js';
import {
  assertCanonicalSeed,
  createDeterministicRng,
  deriveConductorSeed,
} from '../src/deterministic-rng.js';
import { perchToNote, unperchToRelease } from '../src/mapping.js';
import {
  createSimulationCheckpoint,
  SIMULATION_CONFIG_REVISION,
  validateSimulationCheckpoint,
} from '../src/simulation-checkpoint.js';
import { createWorld } from '../src/world.js';

const EVENT_NAMES = Object.freeze([
  'perch',
  'unperch',
  'dawn',
  'dusk',
  'sequence-pattern',
  'sequence-step',
  'agent-resume',
  'season-migration',
  'meter-change',
]);

const DEFERRED_COMMANDS = new Set([
  'control.take', 'control.release', 'control.heartbeat',
  'master.setSeasonLength', 'master.setColor',
  'mix.setParam', 'mix.setMute', 'mix.setSolo',
  'voice.setMode', 'latent.setCursor', 'latent.setMode',
  'preview.start', 'preview.stop',
]);

function oracleError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function freezeTree(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeTree(child);
  return Object.freeze(value);
}

function scalarPayload(value, names) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownNames = Reflect.ownKeys(value);
    if (ownNames.length !== names.length
      || ownNames.some((name) => typeof name !== 'string')
      || !names.every((name) => Object.hasOwn(value, name))) return null;
    const copy = {};
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor?.enumerable !== true || !('value' in descriptor)) return null;
      if ((typeof descriptor.value === 'object' && descriptor.value !== null)
        || typeof descriptor.value === 'function') return null;
      copy[name] = descriptor.value;
    }
    structuredClone(value);
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

const natural = (value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);

function worldRestore(checkpoint) {
  if (checkpoint === null) return null;
  return {
    world: checkpoint.world,
    sequence: {
      worldPatterns: checkpoint.sequence.worldPatterns,
      jungleEditPlans: checkpoint.sequence.jungleEditPlans,
      lastSequenceStep: checkpoint.sequence.lastSequenceStep,
    },
    control: {
      treeControl: checkpoint.control.treeControl,
      agentResumeAt: checkpoint.control.agentResumeAt,
      tempo: checkpoint.control.tempo,
    },
  };
}

function conductorRestore(checkpoint) {
  if (checkpoint === null) return null;
  return {
    conductor: checkpoint.conductor,
    sequence: {
      bridgeCurrent: checkpoint.sequence.bridgeCurrent,
      bridgePrevious: checkpoint.sequence.bridgePrevious,
      reviewedPattern: checkpoint.sequence.reviewedPattern,
      plannedPatterns: checkpoint.sequence.plannedPatterns,
    },
    control: {
      masterControl: checkpoint.control.masterControl,
      pendingUserSeasonLength: checkpoint.control.pendingUserSeasonLength,
    },
  };
}

export function createShadowOracle({
  seed,
  config = CONFIG,
  restoredSnapshot = null,
} = {}) {
  const rootSeed = assertCanonicalSeed(seed);
  if (restoredSnapshot !== null && !validateSimulationCheckpoint(restoredSnapshot, {
    seed: rootSeed,
    configRevision: SIMULATION_CONFIG_REVISION,
  })) throw oracleError('INCOMPATIBLE_SIMULATION_CHECKPOINT');

  const restored = restoredSnapshot === null ? null : structuredClone(restoredSnapshot);
  const ownerConfig = structuredClone(config);
  const worldRng = createDeterministicRng(rootSeed, restored?.rng.world ?? null);
  const conductorRng = createDeterministicRng(
    deriveConductorSeed(rootSeed),
    restored?.rng.conductor ?? null,
  );
  const world = createWorld({
    config: ownerConfig,
    rng: worldRng,
    restoredState: worldRestore(restored),
  });
  const conductor = createDeterministicConductor(world, {
    config: ownerConfig,
    rng: conductorRng,
    restoredState: conductorRestore(restored),
    reviewSource: null,
    ecologyProvider: null,
    getPercussionMode: null,
  });
  let paused = restored?.control.paused ?? false;
  let disposed = false;
  let operationBuffer = null;
  const unsubscribers = [];

  function snapshot() {
    if (disposed) throw oracleError('SHADOW_ORACLE_DISPOSED');
    return freezeTree(structuredClone({
      ...world.getSnapshot(),
      paused,
      season: conductor.getChord().season,
    }));
  }

  function capture(name, payload) {
    if (operationBuffer === null) return;
    const eventPayload = structuredClone(payload);
    operationBuffer.events.push({ name, payload: eventPayload });
    if (name !== 'perch' && name !== 'unperch') return;
    const tree = ownerConfig.trees.find(({ id }) => id === eventPayload.treeId);
    const mapped = name === 'perch'
      ? perchToNote(eventPayload, conductor.getChord(), ownerConfig, tree.registerOffset)
      : unperchToRelease(eventPayload, conductor.getChord(), ownerConfig, tree.registerOffset);
    operationBuffer.audio.push({
      type: name === 'perch' ? 'note.on' : 'note.release',
      treeId: eventPayload.treeId,
      birdId: eventPayload.birdId,
      ...mapped,
    });
  }

  try {
    for (const name of EVENT_NAMES) {
      const unsubscribe = world.on(name, (payload) => capture(name, payload));
      if (typeof unsubscribe !== 'function') throw oracleError('ORACLE_COLLECTOR_INSTALL_FAILED');
      unsubscribers.push(unsubscribe);
    }
  } catch (error) {
    try { conductor.dispose(); } catch { /* preserve installation error */ }
    for (const unsubscribe of unsubscribers) {
      try { unsubscribe(); } catch { /* best effort rollback */ }
    }
    throw error;
  }

  function operate(action) {
    if (disposed) throw oracleError('SHADOW_ORACLE_DISPOSED');
    if (operationBuffer !== null) throw oracleError('NESTED_SHADOW_OPERATION');
    operationBuffer = { events: [], audio: [] };
    try {
      const outcome = action();
      const domainEvents = freezeTree(operationBuffer.events);
      const audioCommands = freezeTree(operationBuffer.audio);
      // The oracle owns no audio device. This point is the independent sink boundary.
      const draft = {
        changed: outcome.changed === true,
        snapshot: snapshot(),
        domainEvents,
        audioCommands,
      };
      if (outcome.commandResult !== undefined) {
        draft.commandResult = freezeTree(structuredClone(outcome.commandResult));
      }
      return freezeTree(draft);
    } finally {
      operationBuffer = null;
    }
  }

  const rejected = (code = 'INVALID_COMMAND_PAYLOAD') => ({
    changed: false,
    commandResult: { accepted: false, code },
  });

  function dispatch(name, payload) {
    if (name === 'runtime.pause' || name === 'runtime.resume') {
      if (scalarPayload(payload, []) === null) return rejected();
      const next = name === 'runtime.pause';
      const changed = paused !== next;
      paused = next;
      return {
        changed,
        commandResult: { accepted: true, code: changed ? 'OK' : 'NO_CHANGE', paused },
      };
    }
    if (name === 'sequence.toggle') {
      const input = scalarPayload(payload, ['treeId', 'pitchBranchId', 'stepIndex']);
      if (input === null
        || !ownerConfig.trees.some(({ id }) => id === input.treeId)
        || !natural(input.pitchBranchId)
        || input.pitchBranchId >= ownerConfig.tree.branches.length
        || !natural(input.stepIndex)) return rejected();
      const result = world.toggleSequenceCell(
        input.treeId, input.pitchBranchId, input.stepIndex,
      );
      if (result === null) return rejected('DOMAIN_REJECTED');
      return {
        changed: true,
        commandResult: {
          accepted: true,
          code: 'OK',
          treeId: input.treeId,
          pitchBranchId: input.pitchBranchId,
          stepIndex: input.stepIndex,
          active: result.active,
        },
      };
    }
    if (name === 'sequence.place') {
      const input = scalarPayload(
        payload, ['treeId', 'pitchBranchId', 'stepIndex', 'stepCount'],
      );
      if (input === null
        || !ownerConfig.trees.some(({ id }) => id === input.treeId)
        || !natural(input.pitchBranchId)
        || input.pitchBranchId >= ownerConfig.tree.branches.length
        || !natural(input.stepIndex)
        || !natural(input.stepCount)
        || input.stepCount < 1
        || input.stepCount > 64
        || input.stepIndex >= input.stepCount) return rejected();
      const placement = world.userPlaceOnBranch(input.treeId, input.pitchBranchId, {
        pitchBranchId: input.pitchBranchId,
        stepIndex: input.stepIndex,
        stepCount: input.stepCount,
      });
      if (placement === null) return rejected('DOMAIN_REJECTED');
      return {
        changed: placement.same !== true,
        commandResult: {
          accepted: true,
          code: placement.same === true ? 'NO_CHANGE' : 'OK',
          placement,
        },
      };
    }
    if (name === 'bird.shoo') {
      const input = scalarPayload(payload, ['birdId']);
      if (input === null || !natural(input.birdId)) return rejected();
      if (!world.userShooBird(input.birdId)) return rejected('DOMAIN_REJECTED');
      return {
        changed: true,
        commandResult: { accepted: true, code: 'OK', birdId: input.birdId },
      };
    }
    if (name === 'transport.setTempo') {
      const input = scalarPayload(payload, ['bpm']);
      if (input === null || !Number.isFinite(input.bpm)) return rejected();
      const before = world.getSnapshot().bpm;
      if (!world.setTempo(input.bpm)) return rejected('DOMAIN_REJECTED');
      const bpm = world.getSnapshot().bpm;
      const changed = bpm !== before;
      return {
        changed,
        commandResult: { accepted: true, code: changed ? 'OK' : 'NO_CHANGE', bpm },
      };
    }
    if (name === 'transport.setMeter') {
      const input = scalarPayload(payload, ['beatsPerBar']);
      if (input === null || ![2, 4, 8].includes(input.beatsPerBar)) return rejected();
      const before = ownerConfig.tempo.beatsPerBar;
      if (!world.setBeatsPerBar(input.beatsPerBar)) return rejected('DOMAIN_REJECTED');
      const changed = ownerConfig.tempo.beatsPerBar !== before;
      return {
        changed,
        commandResult: {
          accepted: true,
          code: changed ? 'OK' : 'NO_CHANGE',
          beatsPerBar: ownerConfig.tempo.beatsPerBar,
          barsPerDay: ownerConfig.tempo.barsPerDay,
        },
      };
    }
    return null;
  }

  function tick(dt) {
    if (disposed) throw oracleError('SHADOW_ORACLE_DISPOSED');
    if (!Number.isFinite(dt) || dt <= 0 || dt > 1 / ownerConfig.sim.tickHz) {
      throw oracleError('INVALID_SIMULATION_TICK');
    }
    return operate(() => {
      if (paused) return { changed: false };
      world.tick(dt);
      return { changed: true };
    });
  }

  function applyCommand(command) {
    return operate(() => {
      const name = command?.name;
      const outcome = dispatch(name, command?.payload);
      if (outcome !== null) return outcome;
      if (name === 'snapshot.request') return rejected('GATEWAY_ONLY_COMMAND');
      if (DEFERRED_COMMANDS.has(name)) return rejected('UNAVAILABLE_IN_PHASE_2');
      return rejected('UNKNOWN_COMMAND');
    });
  }

  function exportCheckpoint({ worldGeneration, revision, eventSeq }) {
    if (disposed) throw oracleError('SHADOW_ORACLE_DISPOSED');
    return createSimulationCheckpoint({
      worldGeneration,
      seed: rootSeed,
      revision,
      eventSeq,
      worldState: world.exportDeterministicState(),
      conductorState: conductor.exportDeterministicState(),
      worldRng,
      conductorRng,
      paused,
    });
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    try { conductor.dispose(); } catch { /* continue independent cleanup */ }
    for (const unsubscribe of unsubscribers) {
      try { unsubscribe(); } catch { /* best effort */ }
    }
    return true;
  }

  return Object.freeze({
    tick,
    applyCommand,
    getSnapshot: snapshot,
    exportCheckpoint,
    dispose,
  });
}
