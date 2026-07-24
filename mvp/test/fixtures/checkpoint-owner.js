import { CONFIG } from '../../src/config.js';
import { createDeterministicConductor } from '../../src/deterministic-conductor.js';
import {
  assertCanonicalSeed,
  createDeterministicRng,
  deriveConductorSeed,
} from '../../src/deterministic-rng.js';
import {
  createSimulationCheckpoint,
  SIMULATION_CONFIG_REVISION,
  validateSimulationCheckpoint,
} from '../../src/simulation-checkpoint.js';
import { createWorld } from '../../src/world.js';

const DOMAIN_EVENT_NAMES = [
  'perch',
  'unperch',
  'dawn',
  'dusk',
  'sequence-pattern',
  'sequence-step',
  'agent-resume',
  'season-migration',
  'meter-change',
];

function ownerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function checkpointError() {
  return ownerError('INVALID_SIMULATION_CHECKPOINT');
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

export function createCheckpointableOwnerFactory({
  config,
  assertCanonicalSeed: seedGate,
  validateSimulationCheckpoint: validateCheckpoint,
  clone,
  createDeterministicRng: createRng,
  deriveConductorSeed: deriveSeed,
  createWorld: createWorldOwner,
  createDeterministicConductor: createConductor,
  createSimulationCheckpoint: createCheckpoint,
}) {
  return function createCheckpointableOwnerWithDependencies({
    seed,
    restoredSnapshot = null,
  } = {}) {
    const canonicalSeed = seedGate(seed);
    if (restoredSnapshot !== null && !validateCheckpoint(restoredSnapshot, {
      seed: canonicalSeed,
      configRevision: SIMULATION_CONFIG_REVISION,
    })) {
      throw checkpointError();
    }

    const restored = restoredSnapshot === null ? null : clone(restoredSnapshot);
    const ownerConfig = clone(config);
    const worldState = worldRestoreSlice(restored);
    const conductorState = conductorRestoreSlice(restored);
    const worldRng = createRng(canonicalSeed, restored?.rng.world ?? null);
    const conductorRng = createRng(
      deriveSeed(canonicalSeed),
      restored?.rng.conductor ?? null,
    );
    const world = createWorldOwner({
      config: ownerConfig,
      rng: worldRng,
      restoredState: worldState,
    });
    const conductor = createConductor(world, {
      config: ownerConfig,
      rng: conductorRng,
      restoredState: conductorState,
      reviewSource: null,
      ecologyProvider: null,
      getPercussionMode: null,
      onPlan: null,
      onApply: null,
      onChord: null,
      onMaster: null,
      onTempoIntent: null,
    });

    const domainEvents = [];
    const collectorUnsubscribers = [];
    try {
      for (const name of DOMAIN_EVENT_NAMES) {
        const unsubscribe = world.on(name, (payload) => {
          domainEvents.push(structuredClone({ name, ...payload }));
        });
        if (typeof unsubscribe !== 'function') throw checkpointError();
        collectorUnsubscribers.push(unsubscribe);
      }
    } catch (error) {
      try {
        conductor.dispose();
      } catch {
        // 构造回滚是 best-effort；保留原始 collector 安装错误。
      }
      for (const unsubscribe of collectorUnsubscribers) {
        try {
          unsubscribe();
        } catch {
          // 构造回滚是 best-effort；一个坏 collector 不得留下其余订阅。
        }
      }
      throw error;
    }

    const worldGeneration = restored?.worldGeneration ?? 'checkpoint-owner-v1';
    const revision = restored?.revision ?? 0;
    const eventSeq = restored?.eventSeq ?? 0;
    const paused = restored?.control.paused ?? false;
    let disposed = false;

    function tick(dt) {
      if (disposed) throw ownerError('DISPOSED_CHECKPOINT_OWNER');
      if (!Number.isFinite(dt) || dt <= 0) {
        throw ownerError('INVALID_CHECKPOINT_OWNER_TICK');
      }
      if (paused) return false;
      world.tick(dt);
      return true;
    }

    function exportCheckpoint() {
      if (disposed) throw ownerError('DISPOSED_CHECKPOINT_OWNER');
      return createCheckpoint({
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
      try {
        conductor.dispose();
      } catch {
        // owner 释放是 best-effort；仍须继续释放九个 collector。
      }
      for (const unsubscribe of collectorUnsubscribers) {
        try {
          unsubscribe();
        } catch {
          // 一个坏 collector 不得阻止其余 collector 释放。
        }
      }
      return true;
    }

    return {
      tick,
      getDomainEvents: () => structuredClone(domainEvents),
      exportCheckpoint,
      dispose,
    };
  };
}

export const createCheckpointableOwner = createCheckpointableOwnerFactory({
  config: CONFIG,
  assertCanonicalSeed,
  validateSimulationCheckpoint,
  clone: (value) => structuredClone(value),
  createDeterministicRng,
  deriveConductorSeed,
  createWorld,
  createDeterministicConductor,
  createSimulationCheckpoint,
});
