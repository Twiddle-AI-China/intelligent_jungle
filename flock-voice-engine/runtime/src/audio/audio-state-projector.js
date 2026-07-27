function clone(value) { return structuredClone(value); }
const WORKER_VOICE = Object.freeze({ melody: 'lead' });
const VOICE_ALIAS = Object.freeze({ melody: 'lead', texture: 'pluck' });

export function projectAudioRecoveryCommands({ simulationRuntime } = {}) {
  const snapshot = simulationRuntime?.getSnapshot?.();
  if (!snapshot) return Object.freeze([]);
  return Object.freeze(Object.entries(snapshot.latent ?? {})
    .filter(([, value]) => value?.preview?.active === true)
    .map(([voice]) => Object.freeze({ type: 'preview.allOff', voice: VOICE_ALIAS[voice] ?? voice })));
}

function assignmentsFor(trees, geometry) {
  const rows = geometry.rowVoices ?? [];
  return Object.fromEntries(trees.map((tree) => {
    const voice = VOICE_ALIAS[tree.species] ?? tree.species;
    const matches = rows.map((item, row) => item === voice ? row : -1).filter((row) => row >= 0);
    return [tree.species, matches.length === 1 ? matches[0] : matches];
  }));
}

function activeNotes(projection, assignments) {
  if (!projection?.chord || !Array.isArray(projection.snapshot?.trees)) return [];
  const notes = [];
  for (const tree of projection.snapshot.trees) {
    const perched = (tree.birds ?? []).filter((bird) => bird.state === 'perched'
      && Number.isInteger(bird.branchId));
    const rows = assignments[tree.species];
    for (const bird of perched) {
      const perchedOnBranch = perched.filter((peer) => peer.branchId === bird.branchId).length;
      const row = Array.isArray(rows) ? rows[Math.abs(bird.id) % rows.length] : rows;
      const mapped = simulationNote(tree, bird, perchedOnBranch, projection.chord);
      if (Number.isInteger(row)) {
        const sequence = bird.sequenceAddress;
        const texture = tree.species === 'texture' && sequence ? {
          pitchBranchId: sequence.pitchBranchId,
          stepIndex: sequence.stepIndex,
          tension: projection.chord.tension,
          masterBpm: projection.snapshot.bpm,
          ...(projection.jungleEditPlans?.[tree.species]
            ? { jungleEditPlan: clone(projection.jungleEditPlans[tree.species]) } : {}),
        } : {};
        notes.push({ row, ...mapped, ...texture });
      }
    }
  }
  return notes;
}

function simulationNote(tree, bird, perchedOnBranch, chord) {
  return perchToNote({ treeId: tree.id, branchId: bird.branchId, perchedOnBranch }, chord,
    DOMAIN_CONFIG, Number(tree.registerOffset ?? 0));
}

export function projectAudioState({ session, simulationRuntime = session?.kernel,
  latentRuntime = null, audioOwner = 'world', ready } = {}) {
  if (!session || typeof simulationRuntime?.getSnapshot !== 'function' || !ready) {
    throw new Error('AUDIO_STATE_PROJECTOR_DEPENDENCIES_REQUIRED');
  }
  const projection = simulationRuntime.getAudioProjection?.() ?? null;
  const snapshot = projection?.snapshot ?? simulationRuntime.getSnapshot();
  const latentPublic = snapshot.latent ?? latentRuntime?.getPublicState?.() ?? {};
  const modes = {};
  const targets = {};
  const availableVoices = new Set(ready.geometry.rowVoices);
  for (const [voice, value] of Object.entries(latentPublic)) {
    const workerVoice = WORKER_VOICE[voice] ?? voice;
    if (!availableVoices.has(workerVoice)) continue;
    modes[workerVoice] = value.owner ?? 'AGENT';
    const cursor = value.cursor ?? {};
    targets[workerVoice] = value.mode === 'pca'
      ? { timbre_pca: clone(cursor.pca ?? [0]) }
      : { timbre_xy: [Number(cursor.x) || 0, Number(cursor.y) || 0], timbre_k: 4 };
  }
  const trees = Array.isArray(snapshot.trees) ? snapshot.trees : [];
  const assignments = assignmentsFor(trees, ready.geometry);
  return {
    stateRevision: session.revision,
    world: { worldId: session.worldId, worldGeneration: session.worldGeneration,
      revision: session.revision, worldTimeSeconds: Number(snapshot.simTime ?? 0) },
    frameMap: { audioEpoch: ready.audioEpoch, worldTimeSeconds: Number(snapshot.simTime ?? 0),
      renderFrame: ready.renderFrame.toString(), sampleRate: ready.geometry.sampleRate },
    voices: { assignments, activeNotes: activeNotes(projection, assignments), activeGates: [], releases: [] },
    latent: { modes, targets },
    mix: clone(projection?.mix ?? { species: {}, masterGain: .5, mute: {}, solo: {}, eq: {}, reverb: {} }),
    audioOwner,
    voiceMode: 'production',
    deterministicSeed: session.seed,
    configRevision: 1,
  };
}
import { DOMAIN_CONFIG } from '../domain/config.js';
import { perchToNote } from '../domain/mapping.js';
