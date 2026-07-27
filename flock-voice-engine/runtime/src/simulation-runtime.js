import { createNullAudioSink } from './audio/null-audio-sink.js';
import { createLeaseManager } from './control/lease-manager.js';
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
import { createLatentRuntime as createLatentState } from './latent/latent-runtime.js';
import { createLatentMapRepository } from './latent/map-repository.js';
import { createPreviewLease } from './latent/preview-lease.js';
import { LATENT_VOICES } from './latent/voice-config.js';
import { LATENT_COMMANDS, MIX_COMMANDS, normalizeLatentCommandPayload } from './protocol/v1.js';

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
const DEFAULT_MIX_STATE = Object.freeze({ species: {}, masterGain: .5, mute: {}, solo: {}, eq: {}, reverb: {} });
const MIX_SPECIES = new Set(['bass', 'pad', 'melody', 'texture']);
function validMixState(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'eq,masterGain,mute,reverb,solo,species') return false;
    if (!Number.isFinite(value.masterGain) || value.masterGain < 0 || value.masterGain > 2) return false;
    for (const key of ['species', 'mute', 'solo', 'eq', 'reverb']) {
      if (!value[key] || Object.getPrototypeOf(value[key]) !== Object.prototype
        || Object.keys(value[key]).some((species) => !MIX_SPECIES.has(species))) return false;
    }
    if (Object.values(value.species).some((item) => !Number.isFinite(item) || item < 0 || item > 2)
      || Object.values(value.reverb).some((item) => !Number.isFinite(item) || item < 0 || item > 1)
      || [...Object.values(value.mute), ...Object.values(value.solo)].some((item) => typeof item !== 'boolean')) return false;
    for (const eq of Object.values(value.eq)) {
      if (!eq || Object.keys(eq).sort().join(',') !== 'high,low,mid'
        || Object.values(eq).some((item) => !Number.isFinite(item) || item < -12 || item > 12)) return false;
    }
    structuredClone(value);
    return true;
  } catch { return false; }
}
function splitRuntimeCheckpoint(value) {
  try {
    if (value === null) return { simulation: null, mix: structuredClone(DEFAULT_MIX_STATE) };
    const mixDescriptor = Object.getOwnPropertyDescriptor(value, 'runtimeAudioMix');
    if (!mixDescriptor) return { simulation: value, mix: structuredClone(DEFAULT_MIX_STATE) };
    if (mixDescriptor.enumerable !== true || !('value' in mixDescriptor)) return null;
    const cloned = structuredClone(value);
    const mix = cloned.runtimeAudioMix;
    delete cloned.runtimeAudioMix;
    return { simulation: cloned, mix: structuredClone(mix) };
  } catch { return null; }
}

export function validateRuntimeCheckpoint(checkpoint, expected) {
  try {
    const parts = splitRuntimeCheckpoint(checkpoint);
    if (!parts) return false;
    const { simulation, mix } = parts;
    return validMixState(mix) && validateSimulationCheckpoint(simulation, expected);
  } catch { return false; }
}

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
  latentRuntime = null,
  previewRuntime = null,
  clock = { now: () => Date.now() },
}) {
  const canonicalSeed = assertCanonicalSeed(seed);
  const restoredParts = splitRuntimeCheckpoint(restoredSnapshot);
  if (restoredSnapshot !== null && (!restoredParts || !validMixState(restoredParts.mix)
    || !validateSimulationCheckpoint(restoredParts.simulation, {
    seed: canonicalSeed,
    configRevision: SIMULATION_CONFIG_REVISION,
  }))) throw runtimeError('INCOMPATIBLE_SIMULATION_CHECKPOINT');
  if (!audioSink || typeof audioSink.accept !== 'function') {
    throw runtimeError('INVALID_AUDIO_SINK');
  }
  if (!(agents === null || (
    typeof agents.scheduleReview === 'function'
    && typeof agents.acceptEnvelope === 'function'
    && typeof agents.takeForBoundary === 'function'
  )) || typeof clock?.now !== 'function') throw runtimeError('INVALID_AGENT_RUNTIME');
  if (!(latentRuntime === null || (
    typeof latentRuntime.updateEcology === 'function'
    && typeof latentRuntime.tick === 'function'
    && typeof latentRuntime.disconnect === 'function'
    && typeof latentRuntime.getPublicState === 'function'
  ))) throw runtimeError('INVALID_LATENT_RUNTIME');
  if (!(previewRuntime === null || (
    typeof previewRuntime.start === 'function'
    && typeof previewRuntime.stop === 'function'
    && typeof previewRuntime.tick === 'function'
    && typeof previewRuntime.disconnect === 'function'
    && typeof previewRuntime.controlWillRelease === 'function'
    && typeof previewRuntime.getPublicState === 'function'
  ))) throw runtimeError('INVALID_PREVIEW_RUNTIME');

  const restored = restoredParts?.simulation ?? null;
  const mixState = restoredParts?.mix ?? structuredClone(DEFAULT_MIX_STATE);
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
  const deferredDisconnects = new Map();
  const collectorUnsubscribers = [];

  function getSnapshot() {
    if (disposed) throw runtimeError('SIMULATION_RUNTIME_DISPOSED');
    const mixChanged = JSON.stringify(mixState) !== JSON.stringify(DEFAULT_MIX_STATE);
    return deepFreeze(structuredClone({
      ...world.getSnapshot(),
      paused,
      season: conductor.getChord().season,
      ...(latentRuntime === null ? {} : { latent: latentPublicState() }),
      ...(mixChanged ? { mix: mixState } : {}),
    }));
  }

  function getAudioProjection() {
    if (disposed) throw runtimeError('SIMULATION_RUNTIME_DISPOSED');
    return deepFreeze(structuredClone({ snapshot: getSnapshot(), chord: conductor.getChord(),
      mix: mixState, jungleEditPlans: world.exportDeterministicState().sequence.jungleEditPlans }));
  }

  function recoverAudioState() {
    return runOperation(() => {
      const voices = previewRuntime?.recoverAllOff?.() ?? [];
      if (voices.length > 0) collect('latent.state', latentPublicState());
      return { changed: voices.length > 0 };
    });
  }

  function latentPublicState() {
    const latent = latentRuntime.getPublicState();
    if (previewRuntime === null) return latent;
    return Object.fromEntries(Object.entries(latent).map(([voice, value]) => [voice, {
      ...value,
      preview: previewRuntime.getPublicState(voice),
    }]));
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
    const textureMetadata = tree.species === 'texture' && name === 'perch' ? {
      pitchBranchId: clonedPayload.pitchBranchId ?? clonedPayload.branchId,
      stepIndex: clonedPayload.stepIndex ?? clonedPayload.sequenceAddress?.stepIndex ?? 0,
      tension: conductor.getChord().tension,
      masterBpm: world.getSnapshot().bpm,
      ...(clonedPayload.jungleEditPlan ? { jungleEditPlan: clonedPayload.jungleEditPlan } : {}),
    } : {};
    const audioCommand = {
      type: name === 'perch' ? 'note.on' : 'note.release',
      treeId: clonedPayload.treeId,
      birdId: clonedPayload.birdId,
      ...mapped,
    };
    activeBatch.audioCommands.push(audioCommand);
    if (Object.keys(textureMetadata).length > 0) {
      if (activeBatch.sinkAudioCommands === activeBatch.audioCommands) {
        activeBatch.sinkAudioCommands = activeBatch.audioCommands.slice(0, -1);
      }
      activeBatch.sinkAudioCommands.push({ ...audioCommand, ...textureMetadata });
    } else if (activeBatch.sinkAudioCommands !== activeBatch.audioCommands) {
      activeBatch.sinkAudioCommands.push(audioCommand);
    }
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
    const audioCommands = [];
    activeBatch = { domainEvents: [], audioCommands, sinkAudioCommands: audioCommands };
    try {
      const result = operation();
      const domainEvents = deepFreeze(activeBatch.domainEvents);
      const collectedAudioCommands = deepFreeze(activeBatch.audioCommands);
      if (activeBatch.sinkAudioCommands.length > 0) {
        audioSink.accept(deepFreeze(activeBatch.sinkAudioCommands));
      }
      const preAcceptedAudioCommands = Array.isArray(result.audioCommands)
        ? structuredClone(result.audioCommands) : [];
      const audioCommands = preAcceptedAudioCommands.length === 0
        ? collectedAudioCommands
        : deepFreeze([
          ...structuredClone(collectedAudioCommands),
          ...preAcceptedAudioCommands,
        ]);
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
      const maintenance = { changed: false, audioCommands: [] };
      const blockedVoices = new Set();
      if (previewRuntime !== null && deferredDisconnects.size > 0) {
        const [key, identity] = deferredDisconnects.entries().next().value;
        const preview = previewRuntime.disconnect(identity);
        const failedVoices = preview.failedVoices ?? [];
        for (const voice of failedVoices) blockedVoices.add(voice);
        if (preview.ok) {
          deferredDisconnects.delete(key);
        } else {
          deferredDisconnects.delete(key);
          deferredDisconnects.set(key, identity);
        }
        const latent = latentRuntime.disconnect(identity, { excludeVoices: failedVoices });
        maintenance.changed = preview.changed || latent.changed;
        maintenance.audioCommands.push(
          ...(preview.audioCommands ?? []), ...(latent.audioCommands ?? []),
        );
        if (maintenance.changed) collect('control.lease', latentPublicState());
      }
      if (previewRuntime !== null) {
        const preview = previewRuntime.tick(clock.now(), {
          excludeVoices: [...blockedVoices],
        });
        for (const voice of preview.failedVoices ?? []) blockedVoices.add(voice);
        maintenance.changed ||= preview.changed;
        maintenance.audioCommands.push(...(preview.audioCommands ?? []));
        if (preview.changed) collect('latent.state', latentPublicState());
      }
      if (paused) {
        if (latentRuntime === null) return maintenance;
        const timed = latentRuntime.tick(clock.now(), {
          excludeVoices: [...blockedVoices],
        });
        if (timed.changed) collect('latent.state', latentPublicState());
        return {
          changed: maintenance.changed || timed.changed,
          audioCommands: [...maintenance.audioCommands, ...timed.audioCommands],
        };
      }
      world.tick(dt);
      if (latentRuntime === null) return {
        changed: true,
        audioCommands: maintenance.audioCommands,
      };
      const ecology = latentRuntime.updateEcology(world.getSnapshot(), dt);
      const timed = latentRuntime.tick(clock.now(), {
        excludeVoices: [...blockedVoices],
      });
      if (ecology.changed || timed.changed) collect('latent.state', latentPublicState());
      return {
        changed: true,
        audioCommands: [
          ...maintenance.audioCommands, ...ecology.audioCommands, ...timed.audioCommands,
        ],
      };
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

  function latentCommandResult(outcome, extraAudioCommands = [], eventName = 'latent.state') {
    if (outcome.changed) collect(eventName, latentPublicState());
    return {
      changed: outcome.changed === true,
      audioCommands: [...extraAudioCommands, ...(outcome.audioCommands ?? [])],
      commandResult: Object.fromEntries(Object.entries(outcome).filter(([key]) => (
        !['changed', 'audioCommands', 'lease', 'releasedVoices', 'failedVoices'].includes(key)
      )).map(([key, value]) => [key === 'ok' ? 'accepted' : key, value])),
    };
  }

  function applyLatentCommand(name, payload, context) {
    if (latentRuntime === null || previewRuntime === null) {
      return unchanged({ accepted: false, code: 'UNAVAILABLE_IN_PHASE_2' });
    }
    const normalized = normalizeLatentCommandPayload(name, payload);
    if (normalized === null || typeof context?.clientId !== 'string'
      || !(typeof context.connectionGeneration === 'string'
        || Number.isSafeInteger(context.connectionGeneration))) {
      return unchanged({ accepted: false, code: 'INVALID_COMMAND_PAYLOAD' });
    }
    const command = {
      ...normalized,
      clientId: context.clientId,
      connectionGeneration: String(context.connectionGeneration),
    };
    try {
      if (name === 'control.take') {
        const cleanup = previewRuntime.tick(clock.now());
        if (!cleanup.ok) return latentCommandResult(cleanup, [], 'control.lease');
        const outcome = latentRuntime.takeControl(command);
        return latentCommandResult(
          { ...outcome, changed: outcome.changed || cleanup.changed },
          cleanup.audioCommands ?? [],
          'control.lease',
        );
      }
      if (name === 'control.heartbeat') {
        const cleanup = previewRuntime.tick(clock.now());
        if (!cleanup.ok) return latentCommandResult(cleanup, [], 'control.lease');
        const outcome = latentRuntime.heartbeat(command);
        return latentCommandResult(
          { ...outcome, changed: outcome.changed || cleanup.changed },
          cleanup.audioCommands ?? [],
          'control.lease',
        );
      }
      if (name === 'control.release') {
        const cleanup = previewRuntime.tick(clock.now());
        if (!cleanup.ok) return latentCommandResult(cleanup, [], 'control.lease');
        const preview = previewRuntime.controlWillRelease(command);
        if (!preview.ok) return latentCommandResult(preview, [], 'control.lease');
        const outcome = latentRuntime.releaseControl(command);
        return latentCommandResult(
          { ...outcome, changed: outcome.changed || preview.changed || cleanup.changed },
          [...(cleanup.audioCommands ?? []), ...(preview.audioCommands ?? [])],
          'control.lease',
        );
      }
      if (name === 'latent.setCursor') {
        return latentCommandResult(latentRuntime.setCursor(command));
      }
      if (name === 'latent.setMode') {
        return latentCommandResult(latentRuntime.setMode(command));
      }
      if (name === 'preview.start') return latentCommandResult(previewRuntime.start(command));
      if (name === 'preview.stop') return latentCommandResult(previewRuntime.stop(command));
    } catch (error) {
      if (error?.code === 'AUDIO_INTENT_REJECTED') {
        return unchanged({ accepted: false, code: 'audio_intent_rejected' });
      }
      throw error;
    }
    return unchanged({ accepted: false, code: 'UNKNOWN_COMMAND' });
  }

  function applyCommand(command, context = {}) {
    return runOperation(() => {
      const name = command?.name;
      if (LATENT_COMMANDS.includes(name)) {
        return applyLatentCommand(name, command.payload, context);
      }
      if (MIX_COMMANDS.includes(name)) {
        const input = command.payload;
        let param;
        let value;
        if (name === 'mix.setMute') { param = 'mute'; value = input.muted; }
        else if (name === 'mix.setSolo') { param = 'solo'; value = input.solo; }
        else { param = input.param === 'gain' ? 'species' : input.param; value = input.value; }
        const species = input.species;
        const previous = param === 'masterGain' ? mixState.masterGain : mixState[param]?.[species];
        if (JSON.stringify(previous) === JSON.stringify(value)) {
          return unchanged({ accepted: true, code: 'NO_CHANGE' });
        }
        const intent = { type: 'mix.set', worldId: 'default', param, value,
          ...(species ? { species } : {}) };
        try { audioSink.accept(deepFreeze([intent])); } catch {
          return unchanged({ accepted: false, code: 'audio_intent_rejected' });
        }
        if (param === 'masterGain') mixState.masterGain = value;
        else mixState[param][species] = structuredClone(value);
        return { changed: true, audioCommands: [intent],
          commandResult: { accepted: true, code: 'OK' } };
      }
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

  function disconnect(identity) {
    if (latentRuntime === null) return runOperation(() => ({ changed: false }));
    return runOperation(() => {
      const normalizedIdentity = {
        clientId: identity?.clientId,
        connectionGeneration: String(identity?.connectionGeneration),
      };
      const preview = previewRuntime?.disconnect(normalizedIdentity)
        ?? { changed: false, audioCommands: [] };
      const latent = latentRuntime.disconnect(normalizedIdentity, {
        excludeVoices: preview.failedVoices ?? [],
      });
      if (!preview.ok && preview.code === 'audio_intent_rejected') {
        const key = JSON.stringify([
          normalizedIdentity.clientId, normalizedIdentity.connectionGeneration,
        ]);
        deferredDisconnects.set(key, Object.freeze({
          clientId: normalizedIdentity.clientId,
          connectionGeneration: normalizedIdentity.connectionGeneration,
        }));
        if (preview.changed || latent.changed) collect('control.lease', latentPublicState());
        return {
          changed: preview.changed || latent.changed,
          audioCommands: [...(preview.audioCommands ?? []), ...(latent.audioCommands ?? [])],
          commandResult: { accepted: false, code: preview.code },
        };
      }
      deferredDisconnects.delete(JSON.stringify([
        normalizedIdentity.clientId, normalizedIdentity.connectionGeneration,
      ]));
      if (preview.changed || latent.changed) collect('control.lease', latentPublicState());
      return {
        changed: preview.changed || latent.changed,
        audioCommands: [...(preview.audioCommands ?? []), ...(latent.audioCommands ?? [])],
      };
    });
  }

  function getLatentMap(voice) {
    if (latentRuntime === null || typeof latentRuntime.getPublicMap !== 'function') {
      throw runtimeError('LATENT_UNAVAILABLE');
    }
    return latentRuntime.getPublicMap(voice);
  }

  function exportCheckpoint({ worldGeneration, revision, eventSeq }) {
    if (disposed) throw runtimeError('SIMULATION_RUNTIME_DISPOSED');
    const checkpoint = createSimulationCheckpoint({
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
    if (JSON.stringify(mixState) === JSON.stringify(DEFAULT_MIX_STATE)) return checkpoint;
    return deepFreeze({ ...structuredClone(checkpoint), runtimeAudioMix: structuredClone(mixState) });
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
    disconnect,
    getLatentMap,
    getSnapshot,
    getAudioProjection,
    recoverAudioState,
    exportCheckpoint,
    dispose,
  });
}

export function createSimulationKernelFactory({
  configTemplate = DOMAIN_CONFIG,
  createAudioSink = createNullAudioSink,
  agents = null,
  clock = { now: () => Date.now() },
  enableLatent = false,
  sharedLeaseManager = null,
  createLatentRuntime = ({ audioSink, runtimeClock, leaseManager }) => createLatentState({
    voiceConfig: LATENT_VOICES,
    mapRepository: createLatentMapRepository({
      assetRoot: new URL('../../assets/timbre/voice_maps/', import.meta.url),
    }),
    audioSink,
    clock: runtimeClock,
    leaseManager,
  }),
  createPreviewRuntime = ({ audioSink, runtimeClock, leaseManager }) => createPreviewLease({
    audioSink, clock: runtimeClock, leaseManager,
  }),
} = {}) {
  if (typeof createAudioSink !== 'function') throw runtimeError('INVALID_AUDIO_SINK_FACTORY');
  if (typeof enableLatent !== 'boolean'
    || (enableLatent && (
      typeof createLatentRuntime !== 'function'
      || typeof createPreviewRuntime !== 'function'
    ))) {
    throw runtimeError('INVALID_LATENT_FACTORY');
  }
  return ({ seed, restoredSnapshot = null }) => {
    const audioSink = createAudioSink();
    const leaseManager = enableLatent ? (sharedLeaseManager ?? createLeaseManager({ clock })) : null;
    const latentRuntime = enableLatent
      ? createLatentRuntime({ audioSink, runtimeClock: clock, leaseManager })
      : null;
    const previewRuntime = enableLatent
      ? createPreviewRuntime({ audioSink, runtimeClock: clock, leaseManager })
      : null;
    return createSimulationRuntime({
      seed,
      config: configTemplate,
      audioSink,
      restoredSnapshot,
      agents,
      latentRuntime,
      previewRuntime,
      clock,
    });
  };
}
