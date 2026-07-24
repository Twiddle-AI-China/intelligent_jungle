import { createHash } from 'node:crypto';

import { CONFIG } from '../../src/config.js';
import { createWorld } from '../../src/world.js';
import { mulberry32 } from '../helpers.js';

const DOMAIN_EVENT_NAMES = ['perch', 'unperch', 'dawn', 'dusk', 'sequence-pattern'];

function roundFinite(value, decimalPlaces) {
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return 'NaN';
    return value > 0 ? 'Infinity' : '-Infinity';
  }
  const rounded = Number(value.toFixed(decimalPlaces));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function canonicalize(value, decimalPlaces = 12) {
  if (typeof value === 'number') return roundFinite(value, decimalPlaces);
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry, decimalPlaces));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key], decimalPlaces)]),
    );
  }
  if (value === undefined) return null;
  return value;
}

function hashTrace(records) {
  return createHash('sha256')
    .update(JSON.stringify(records))
    .digest('hex');
}

function createCountingRng(seed) {
  const source = mulberry32(seed);
  let drawCount = 0;
  const rng = () => {
    drawCount += 1;
    return source();
  };
  rng.getDrawCount = () => drawCount;
  return rng;
}

function projectFrame(frame) {
  return {
    season: frame.season,
    seasonDay: frame.seasonDay,
    seasonLength: frame.seasonLength,
    progressionStep: frame.progressionStep,
    progressionCycle: frame.progressionCycle,
    progressionId: frame.progressionId,
    period: frame.period,
    skeletonId: frame.skeleton.id,
    skeletonNotes: frame.skeleton.notes,
    colorId: frame.color.id,
    colorNotes: frame.color.notes,
    tension: frame.tension,
  };
}

function occupiedCells(pattern) {
  return (pattern?.occupiedCells ?? []).map((cell) => [
    cell.pitchBranchId,
    cell.stepIndex,
    cell.count,
  ]);
}

export function runConductorScenario({
  createConductor,
  worldSeed,
  conductorSeed,
  ticks,
  dt,
}) {
  const config = structuredClone(CONFIG);
  const worldRng = createCountingRng(worldSeed);
  const conductorRng = createCountingRng(conductorSeed);
  const world = createWorld({ config, rng: worldRng });
  const domainEvents = [];
  const callbacks = [];

  for (const name of DOMAIN_EVENT_NAMES) {
    world.on(name, (payload) => {
      domainEvents.push(canonicalize({ name, ...payload }));
    });
  }

  const captureCallback = (name) => (payload) => {
    callbacks.push(canonicalize({ name, ...payload }));
  };
  const conductor = createConductor(world, {
    config,
    rng: conductorRng,
    onPlan: captureCallback('onPlan'),
    onApply: captureCallback('onApply'),
    onChord: captureCallback('onChord'),
    onMaster: captureCallback('onMaster'),
  });

  for (let index = 0; index < ticks; index += 1) world.tick(dt);

  const snapshot = world.getSnapshot();
  const eventCounts = Object.fromEntries(DOMAIN_EVENT_NAMES.map((name) => [name, 0]));
  for (const event of domainEvents) eventCounts[event.name] += 1;
  const first = domainEvents[0] ?? null;
  const branchPreferences = Object.fromEntries(config.trees.map((tree) => [
    tree.id,
    world.getBranchPreference(tree.id).map((value) => roundFinite(value, 6)),
  ]));
  const occupiedSequenceCells = Object.fromEntries(config.trees.map((tree) => [
    tree.id,
    occupiedCells(conductor.getPlannedSequencePattern(tree.id)),
  ]));

  return canonicalize({
    worldRngDrawCount: worldRng.getDrawCount(),
    conductorRngDrawCount: conductorRng.getDrawCount(),
    snapshot: {
      simTime: snapshot.simTime,
      day: snapshot.day,
      phase: snapshot.phase,
      bpm: snapshot.bpm,
      perchedTotal: snapshot.perchedTotal,
    },
    frame: projectFrame(conductor.getFrame()),
    master: conductor.getMasterState(),
    eventCounts,
    firstEvent: first ? {
      name: first.name,
      treeId: first.treeId,
      birdId: first.birdId,
      branchId: first.branchId,
      day: first.day,
    } : null,
    branchPreferences,
    holdCounters: Object.fromEntries(config.trees.map((tree) => [
      tree.id,
      conductor.getHoldState(tree.id).counter,
    ])),
    occupiedSequenceCells,
    eventTraceSha256: hashTrace(domainEvents),
    callbackTraceSha256: hashTrace(callbacks),
  });
}
