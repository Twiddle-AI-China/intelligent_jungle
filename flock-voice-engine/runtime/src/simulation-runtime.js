import { createNullAudioSink } from './audio/null-audio-sink.js';
import { DOMAIN_CONFIG } from './domain/config.js';
import { createDeterministicConductor } from './domain/deterministic-conductor.js';
import {
  assertCanonicalSeed,
  createDeterministicRng,
  deriveConductorSeed,
} from './domain/deterministic-rng.js';
import { perchToNote, unperchToRelease } from './domain/mapping.js';
import {
  createSimulationCheckpoint,
  SIMULATION_CONFIG_REVISION,
  validateSimulationCheckpoint,
} from './domain/simulation-checkpoint.js';
import { createWorld } from './domain/world.js';

const DOMAIN_EVENT_NAMES = Object.freeze([
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

const LATER_PHASE_COMMANDS = new Set([
  'control.take',
  'control.release',
  'control.heartbeat',
  'master.setSeasonLength',
  'master.setColor',
  'mix.setParam',
  'mix.setMute',
  'mix.setSolo',
  'voice.setMode',
  'latent.setCursor',
  'latent.setMode',
  'preview.start',
  'preview.stop',
]);

function runtimeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactPayload(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string')
    || !keys.every((key) => Object.hasOwn(value, key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && 'value' in descriptor;
  });
}

const nonNegativeInteger = (value) => (
  Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
);

function worldRestoreSlice(checkpoint) {
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

function conductorRestoreSlice(checkpoint) {
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

export function createSimulationRuntime({
  seed,
  config = DOMAIN_CONFIG,
  audioSink = createNullAudioSink(),
  restoredSnapshot = null,
}) {
  const canonicalSeed = assertCanonicalSeed(seed);
  if (restoredSnapshot !== null && !validateSimulationCheckpoint(restoredSnapshot, {
    seed: canonicalSeed,
    configRevision: SIMULATION_CONFIG_REVISION,
  })) throw runtimeError('INCOMPATIBLE_SIMULATION_CHECKPOINT');
  if (!audioSink || typeof audioSink.accept !== 'function') {
    throw runtimeError('INVALID_AUDIO_SINK');
  }

  const restored = restoredSnapshot === null ? null : structuredClone(restoredSnapshot);
  const runtimeConfig = structuredClone(config);
  const worldRng = createDeterministicRng(canonicalSeed, restored?.rng.world ?? null);
  const conductorRng = createDeterministicRng(
    deriveConductorSeed(canonicalSeed),
    restored?.rng.conductor ?? null,
  );
  const world = createWorld({
    config: runtimeConfig,
    rng: worldRng,
    restoredState: worldRestoreSlice(restored),
  });
  const conductor = createDeterministicConductor(world, {
    config: runtimeConfig,
    rng: conductorRng,
    restoredState: conductorRestoreSlice(restored),
    reviewSource: null,
    ecologyProvider: null,
    getPercussionMode: null,
  });
  let paused = restored?.control.paused ?? false;
  let disposed = false;
  let activeBatch = null;
  const collectorUnsubscribers = [];

  function getSnapshot() {
    if (disposed) throw runtimeError('SIMULATION_RUNTIME_DISPOSED');
    return deepFreeze(structuredClone({
      ...world.getSnapshot(),
      paused,
      season: conductor.getChord().season,
    }));
  }

  function collect(name, payload) {
    if (activeBatch === null) return;
    const clonedPayload = structuredClone(payload);
    activeBatch.domainEvents.push({ name, payload: clonedPayload });
    if (name !== 'perch' && name !== 'unperch') return;
    const tree = runtimeConfig.trees.find(({ id }) => id === clonedPayload.treeId);
    const mapped = name === 'perch'
      ? perchToNote(clonedPayload, conductor.getChord(), runtimeConfig, tree.registerOffset)
      : unperchToRelease(clonedPayload, conductor.getChord(), runtimeConfig, tree.registerOffset);
    activeBatch.audioCommands.push({
      type: name === 'perch' ? 'note.on' : 'note.release',
      treeId: clonedPayload.treeId,
      birdId: clonedPayload.birdId,
      ...mapped,
    });
  }

  try {
    for (const name of DOMAIN_EVENT_NAMES) {
      const unsubscribe = world.on(name, (payload) => collect(name, payload));
      if (typeof unsubscribe !== 'function') throw runtimeError('DOMAIN_COLLECTOR_INSTALL_FAILED');
      collectorUnsubscribers.push(unsubscribe);
    }
  } catch (error) {
    try { conductor.dispose(); } catch { /* best-effort constructor rollback */ }
    for (const unsubscribe of collectorUnsubscribers) {
      try { unsubscribe(); } catch { /* continue rollback */ }
    }
    throw error;
  }

  function runOperation(operation) {
    if (disposed) throw runtimeError('SIMULATION_RUNTIME_DISPOSED');
    if (activeBatch !== null) throw runtimeError('NESTED_SIMULATION_OPERATION');
    activeBatch = { domainEvents: [], audioCommands: [] };
    try {
      const result = operation();
      const domainEvents = deepFreeze(activeBatch.domainEvents);
      const audioCommands = deepFreeze(activeBatch.audioCommands);
      if (audioCommands.length > 0) audioSink.accept(audioCommands);
      const draft = {
        changed: result.changed === true,
        snapshot: getSnapshot(),
        domainEvents,
        audioCommands,
      };
      if (result.commandResult !== undefined) {
        draft.commandResult = deepFreeze(structuredClone(result.commandResult));
      }
      return deepFreeze(draft);
    } finally {
      activeBatch = null;
    }
  }

  function unchanged(commandResult) {
    return { changed: false, commandResult };
  }

  function applyKnownCommand(name, payload) {
    if (name === 'runtime.pause' || name === 'runtime.resume') {
      if (!exactPayload(payload, [])) {
        return unchanged({ accepted: false, code: 'INVALID_COMMAND_PAYLOAD' });
      }
      const next = name === 'runtime.pause';
      const changed = paused !== next;
      paused = next;
      return {
        changed,
        commandResult: { accepted: true, code: changed ? 'OK' : 'NO_CHANGE', paused },
      };
    }

    if (name === 'sequence.toggle') {
      if (!exactPayload(payload, ['treeId', 'pitchBranchId', 'stepIndex'])
        || !runtimeConfig.trees.some(({ id }) => id === payload.treeId)
        || !nonNegativeInteger(payload.pitchBranchId)
        || payload.pitchBranchId >= runtimeConfig.tree.branches.length
        || !nonNegativeInteger(payload.stepIndex)) {
        return unchanged({ accepted: false, code: 'INVALID_COMMAND_PAYLOAD' });
      }
      const toggled = world.toggleSequenceCell(
        payload.treeId,
        payload.pitchBranchId,
        payload.stepIndex,
      );
      if (toggled === null) return unchanged({ accepted: false, code: 'DOMAIN_REJECTED' });
      return {
        changed: true,
        commandResult: {
          accepted: true,
          code: 'OK',
          treeId: payload.treeId,
          pitchBranchId: payload.pitchBranchId,
          stepIndex: payload.stepIndex,
          active: toggled.active,
        },
      };
    }

    if (name === 'sequence.place') {
      if (!exactPayload(payload, ['treeId', 'pitchBranchId', 'stepIndex', 'stepCount'])
        || !runtimeConfig.trees.some(({ id }) => id === payload.treeId)
        || !nonNegativeInteger(payload.pitchBranchId)
        || payload.pitchBranchId >= runtimeConfig.tree.branches.length
        || !nonNegativeInteger(payload.stepIndex)
        || !nonNegativeInteger(payload.stepCount)
        || payload.stepCount < 1
        || payload.stepCount > 64
        || payload.stepIndex >= payload.stepCount) {
        return unchanged({ accepted: false, code: 'INVALID_COMMAND_PAYLOAD' });
      }
      const placement = world.userPlaceOnBranch(
        payload.treeId,
        payload.pitchBranchId,
        {
          pitchBranchId: payload.pitchBranchId,
          stepIndex: payload.stepIndex,
          stepCount: payload.stepCount,
        },
      );
      if (placement === null) return unchanged({ accepted: false, code: 'DOMAIN_REJECTED' });
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
      if (!exactPayload(payload, ['birdId']) || !nonNegativeInteger(payload.birdId)) {
        return unchanged({ accepted: false, code: 'INVALID_COMMAND_PAYLOAD' });
      }
      if (!world.userShooBird(payload.birdId)) {
        return unchanged({ accepted: false, code: 'DOMAIN_REJECTED' });
      }
      return {
        changed: true,
        commandResult: { accepted: true, code: 'OK', birdId: payload.birdId },
      };
    }

    if (name === 'transport.setTempo') {
      if (!exactPayload(payload, ['bpm']) || !Number.isFinite(payload.bpm)) {
        return unchanged({ accepted: false, code: 'INVALID_COMMAND_PAYLOAD' });
      }
      const before = world.getSnapshot().bpm;
      if (!world.setTempo(payload.bpm)) {
        return unchanged({ accepted: false, code: 'DOMAIN_REJECTED' });
      }
      const bpm = world.getSnapshot().bpm;
      const changed = bpm !== before;
      return {
        changed,
        commandResult: { accepted: true, code: changed ? 'OK' : 'NO_CHANGE', bpm },
      };
    }

    if (name === 'transport.setMeter') {
      if (!exactPayload(payload, ['beatsPerBar']) || ![2, 4, 8].includes(payload.beatsPerBar)) {
        return unchanged({ accepted: false, code: 'INVALID_COMMAND_PAYLOAD' });
      }
      const before = runtimeConfig.tempo.beatsPerBar;
      if (!world.setBeatsPerBar(payload.beatsPerBar)) {
        return unchanged({ accepted: false, code: 'DOMAIN_REJECTED' });
      }
      const changed = runtimeConfig.tempo.beatsPerBar !== before;
      return {
        changed,
        commandResult: {
          accepted: true,
          code: changed ? 'OK' : 'NO_CHANGE',
          beatsPerBar: runtimeConfig.tempo.beatsPerBar,
          barsPerDay: runtimeConfig.tempo.barsPerDay,
        },
      };
    }

    return null;
  }

  function tick(dt) {
    if (disposed) throw runtimeError('SIMULATION_RUNTIME_DISPOSED');
    if (!Number.isFinite(dt) || dt <= 0 || dt > 1 / runtimeConfig.sim.tickHz) {
      throw runtimeError('INVALID_SIMULATION_TICK');
    }
    return runOperation(() => {
      if (paused) return { changed: false };
      world.tick(dt);
      return { changed: true };
    });
  }

  function applyCommand(command) {
    return runOperation(() => {
      const name = command?.name;
      const known = applyKnownCommand(name, command?.payload);
      if (known !== null) return known;
      if (name === 'snapshot.request') {
        return unchanged({ accepted: false, code: 'GATEWAY_ONLY_COMMAND' });
      }
      if (LATER_PHASE_COMMANDS.has(name)) {
        return unchanged({ accepted: false, code: 'UNAVAILABLE_IN_PHASE_2' });
      }
      return unchanged({ accepted: false, code: 'UNKNOWN_COMMAND' });
    });
  }

  function exportCheckpoint({ worldGeneration, revision, eventSeq }) {
    if (disposed) throw runtimeError('SIMULATION_RUNTIME_DISPOSED');
    return createSimulationCheckpoint({
      worldGeneration,
      seed: canonicalSeed,
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
    try { conductor.dispose(); } catch { /* continue collector cleanup */ }
    for (const unsubscribe of collectorUnsubscribers) {
      try { unsubscribe(); } catch { /* best-effort exact-once cleanup */ }
    }
    return true;
  }

  return Object.freeze({
    tick,
    applyCommand,
    getSnapshot,
    exportCheckpoint,
    dispose,
  });
}

export function createSimulationKernelFactory({
  configTemplate = DOMAIN_CONFIG,
  createAudioSink = createNullAudioSink,
} = {}) {
  if (typeof createAudioSink !== 'function') throw runtimeError('INVALID_AUDIO_SINK_FACTORY');
  return ({ seed, restoredSnapshot = null }) => createSimulationRuntime({
    seed,
    config: configTemplate,
    audioSink: createAudioSink(),
    restoredSnapshot,
  });
}
