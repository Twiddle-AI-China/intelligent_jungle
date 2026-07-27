import { createNullAudioSink } from './audio/null-audio-sink.js';
import { DOMAIN_CONFIG } from './domain/config.js';
import {
  buildAgentReview,
  createDeterministicConductor,
} from './domain/deterministic-conductor.js';
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
import { projectAgentStatus } from './agents/status-projector.js';
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

function snapshotExactPayload(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== 'string')
      || !keys.every((key) => Object.hasOwn(value, key))) return null;
    const snapshot = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true || !('value' in descriptor)) return null;
      if ((typeof descriptor.value === 'object' && descriptor.value !== null)
        || typeof descriptor.value === 'function') return null;
      snapshot[key] = descriptor.value;
    }
    // structuredClone rejects transparent/nested/revoked Proxies. Descriptor-first
    // extraction above ensures this preflight cannot invoke an accessor.
    structuredClone(value);
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
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
  agents = null,
  clock = { now: () => Date.now() },
}) {
  const canonicalSeed = assertCanonicalSeed(seed);
  if (restoredSnapshot !== null && !validateSimulationCheckpoint(restoredSnapshot, {
    seed: canonicalSeed,
    configRevision: SIMULATION_CONFIG_REVISION,
  })) throw runtimeError('INCOMPATIBLE_SIMULATION_CHECKPOINT');
  if (!audioSink || typeof audioSink.accept !== 'function') {
    throw runtimeError('INVALID_AUDIO_SINK');
  }
  if (!(agents === null || (
    typeof agents.scheduleReview === 'function'
    && typeof agents.acceptEnvelope === 'function'
    && typeof agents.takeForBoundary === 'function'
  )) || typeof clock?.now !== 'function') throw runtimeError('INVALID_AGENT_RUNTIME');

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
  let agentContext = null;
  const agentBridge = agents === null ? null : {
    takeForBoundary({ kind, day, currentDomain }) {
      if (agentContext === null) throw runtimeError('AGENT_CONTEXT_REQUIRED');
      const outcome = agents.takeForBoundary({
        worldGeneration: agentContext.worldGeneration,
        currentWorldRevision: agentContext.currentWorldRevision,
        kind,
        day,
        currentDomain,
      });
      const decision = projectAgentStatus({ lastDecision: outcome }).lastDecision;
      if (decision !== null) collect('decision', decision);
      return outcome;
    },
    scheduleReview({ reviewedDay, applyBoundary, snapshot }) {
      if (agentContext === null) throw runtimeError('AGENT_CONTEXT_REQUIRED');
      const scheduleSeq = agentContext.currentWorldRevision + 1;
      return agents.scheduleReview(buildAgentReview({
        requestId: `${agentContext.worldGeneration}:${scheduleSeq}:${reviewedDay}`,
        scheduleSeq,
        worldId: 'default',
        worldGeneration: agentContext.worldGeneration,
        scheduledWorldRevision: agentContext.currentWorldRevision,
        reviewedDay,
        applyBoundary,
        snapshot,
        createdAtMs: Math.max(0, Math.floor(Number(clock.now()) || 0)),
      }));
    },
  };
  const conductor = createDeterministicConductor(world, {
    config: runtimeConfig,
    rng: conductorRng,
    restoredState: conductorRestoreSlice(restored),
    reviewSource: null,
    ecologyProvider: null,
    getPercussionMode: null,
    agentBridge,
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
      if (snapshotExactPayload(payload, []) === null) {
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
      const input = snapshotExactPayload(payload, ['treeId', 'pitchBranchId', 'stepIndex']);
      if (input === null
        || !runtimeConfig.trees.some(({ id }) => id === input.treeId)
        || !nonNegativeInteger(input.pitchBranchId)
        || input.pitchBranchId >= runtimeConfig.tree.branches.length
        || !nonNegativeInteger(input.stepIndex)) {
        return unchanged({ accepted: false, code: 'INVALID_COMMAND_PAYLOAD' });
      }
      const toggled = world.toggleSequenceCell(
        input.treeId,
        input.pitchBranchId,
        input.stepIndex,
      );
      if (toggled === null) return unchanged({ accepted: false, code: 'DOMAIN_REJECTED' });
      return {
        changed: true,
        commandResult: {
          accepted: true,
          code: 'OK',
          treeId: input.treeId,
          pitchBranchId: input.pitchBranchId,
          stepIndex: input.stepIndex,
          active: toggled.active,
        },
      };
    }

    if (name === 'sequence.place') {
      const input = snapshotExactPayload(
        payload,
        ['treeId', 'pitchBranchId', 'stepIndex', 'stepCount'],
      );
      if (input === null
        || !runtimeConfig.trees.some(({ id }) => id === input.treeId)
        || !nonNegativeInteger(input.pitchBranchId)
        || input.pitchBranchId >= runtimeConfig.tree.branches.length
        || !nonNegativeInteger(input.stepIndex)
        || !nonNegativeInteger(input.stepCount)
        || input.stepCount < 1
        || input.stepCount > 64
        || input.stepIndex >= input.stepCount) {
        return unchanged({ accepted: false, code: 'INVALID_COMMAND_PAYLOAD' });
      }
      const placement = world.userPlaceOnBranch(
        input.treeId,
        input.pitchBranchId,
        {
          pitchBranchId: input.pitchBranchId,
          stepIndex: input.stepIndex,
          stepCount: input.stepCount,
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
      const input = snapshotExactPayload(payload, ['birdId']);
      if (input === null || !nonNegativeInteger(input.birdId)) {
        return unchanged({ accepted: false, code: 'INVALID_COMMAND_PAYLOAD' });
      }
      if (!world.userShooBird(input.birdId)) {
        return unchanged({ accepted: false, code: 'DOMAIN_REJECTED' });
      }
      return {
        changed: true,
        commandResult: { accepted: true, code: 'OK', birdId: input.birdId },
      };
    }

    if (name === 'transport.setTempo') {
      const input = snapshotExactPayload(payload, ['bpm']);
      if (input === null || !Number.isFinite(input.bpm)) {
        return unchanged({ accepted: false, code: 'INVALID_COMMAND_PAYLOAD' });
      }
      const before = world.getSnapshot().bpm;
      if (!world.setTempo(input.bpm)) {
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
      const input = snapshotExactPayload(payload, ['beatsPerBar']);
      if (input === null || ![2, 4, 8].includes(input.beatsPerBar)) {
        return unchanged({ accepted: false, code: 'INVALID_COMMAND_PAYLOAD' });
      }
      const before = runtimeConfig.tempo.beatsPerBar;
      if (!world.setBeatsPerBar(input.beatsPerBar)) {
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

  function setAgentContext({ worldGeneration, currentWorldRevision }) {
    if (disposed) throw runtimeError('SIMULATION_RUNTIME_DISPOSED');
    if (typeof worldGeneration !== 'string' || !worldGeneration
      || !nonNegativeInteger(currentWorldRevision)) {
      throw runtimeError('INVALID_AGENT_CONTEXT');
    }
    if (agentContext?.worldGeneration !== worldGeneration) {
      agents?.resetGeneration?.(worldGeneration);
    }
    agentContext = Object.freeze({ worldGeneration, currentWorldRevision });
    return true;
  }

  function acceptAgentResult(envelope) {
    if (agents === null) throw runtimeError('AGENTS_UNAVAILABLE');
    if (agentContext === null) throw runtimeError('AGENT_CONTEXT_REQUIRED');
    return runOperation(() => {
      const accepted = agents.acceptEnvelope(envelope, {
        worldGeneration: agentContext.worldGeneration,
        currentWorldRevision: agentContext.currentWorldRevision,
        currentDay: world.getSnapshot().day,
      });
      return { changed: false, commandResult: { accepted, code: accepted ? 'OK' : 'STALE_DISCARDED' } };
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
    setAgentContext,
    acceptAgentResult,
    applyCommand,
    getSnapshot,
    exportCheckpoint,
    dispose,
  });
}

export function createSimulationKernelFactory({
  configTemplate = DOMAIN_CONFIG,
  createAudioSink = createNullAudioSink,
  agents = null,
  clock = { now: () => Date.now() },
} = {}) {
  if (typeof createAudioSink !== 'function') throw runtimeError('INVALID_AUDIO_SINK_FACTORY');
  return ({ seed, restoredSnapshot = null }) => createSimulationRuntime({
    seed,
    config: configTemplate,
    audioSink: createAudioSink(),
    restoredSnapshot,
    agents,
    clock,
  });
}
