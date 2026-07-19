import { CONFIG } from '../src/config.js';
import { createWorld } from '../src/world.js';
import { createDayObserver, deviationReport, scoreDay } from '../src/economy.js';
import { attachPipelineConductor, harmonyScoreFromCounts } from '../src/agent.js';
import { chordFromFrame, colorOptions, skeletonForSeason } from '../src/harmony.js';
import { noteFromBranch } from '../src/mapping.js';

export const DEFAULT_SEED = 0x4c4353;
export const DEFAULT_DAYS = 24;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const variance = (values) => {
  if (!values.length) return 0;
  const center = mean(values);
  return mean(values.map((value) => (value - center) ** 2));
};
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const round = (value, digits = 4) => Number(value.toFixed(digits));

function frameForDay(day, config = CONFIG) {
  const seasonLength = config.harmony.defaultSeasonLength;
  const seasonIndex = Math.floor((day - 1) / seasonLength) % config.harmony.seasons.length;
  const season = config.harmony.seasons[seasonIndex];
  const seasonDay = (day - 1) % seasonLength;
  const colors = colorOptions(season, config.harmony);
  const color = colors[seasonDay % colors.length];
  const span = Math.max(1, seasonLength - 1);
  return {
    season,
    seasonDay,
    seasonLength,
    skeleton: skeletonForSeason(season, config.harmony),
    color,
    tension: config.harmony.tensionBase
      + (config.harmony.tensionPeak - config.harmony.tensionBase) * seasonDay / span,
  };
}

function createEcologyTracker(world, config, { countManualAsRandom = false } = {}) {
  const observers = Object.fromEntries(config.trees.map((tree) => [
    tree.id,
    createDayObserver(config.economy.prefs[tree.species], {
      beatsPerDay: config.tempo.barsPerDay * config.tempo.beatsPerBar,
    }),
  ]));
  const latest = {};
  const days = [];
  const observedCause = (event) => countManualAsRandom && event.cause === 'manual'
    ? undefined : event.cause;
  world.on('perch', (event) => observers[event.treeId]?.feed({
    ...event, event: 'perch', cause: observedCause(event),
  }));
  world.on('unperch', (event) => observers[event.treeId]?.feed({
    ...event,
    event: 'unperch',
    cause: observedCause(event),
    dwellTime: Number.isFinite(event.dwellBeats) ? event.dwellBeats : event.dwellTime,
  }));
  world.onBeforeDawn(({ stats }) => {
    const perTree = {};
    for (const tree of config.trees) {
      const observed = observers[tree.id].finishDay();
      const prefs = config.economy.prefs[tree.species];
      const report = deviationReport(observed, prefs);
      const entry = {
        branchChangesPerLoop: observed.branchChanges,
        meanDwellBeats: observed.meanDwell,
        clusterSize: observed.cohortSize,
        score: scoreDay(observed, prefs),
        deviation: {
          branchChanges: { direction: report.branchChanges, amount: report.magnitude.branchChanges },
          meanDwell: { direction: report.meanDwell, amount: report.magnitude.meanDwell },
          cohortSize: { direction: report.cohortSize, amount: report.magnitude.cohortSize },
        },
      };
      latest[tree.id] = entry;
      perTree[tree.id] = { ...entry, worldStats: stats.trees[tree.id] };
    }
    days.push({ day: stats.day, trees: perTree });
  });
  return { latest, days };
}

function recordEvents(world, chordAtEvent) {
  const events = [];
  for (const type of ['perch', 'unperch', 'dawn']) {
    world.on(type, (event) => events.push({
      type,
      ...event,
      ...(type === 'perch' ? { chord: chordAtEvent(event.day) } : {}),
    }));
  }
  return events;
}

function installRandomDriver(world, rng, config) {
  for (const tree of config.trees) world.setTreeControl(tree.id, 'USER');
  const nextAction = new Map();
  const allowedFor = (tree) => config.species[tree.species].allowedBranches
    ?? config.tree.branches.map((branch) => branch.id);
  const schedule = (bird, now) => {
    // 真随机基线不继承物种驻留/活跃窗；0.25–6.25 拍的连续时间也故意不量化到拍。
    nextAction.set(bird.id, now + 0.25 + rng() * 6);
  };
  return function step() {
    const snapshot = world.getSnapshot();
    for (const tree of snapshot.trees) {
      const allowed = allowedFor(tree);
      for (const bird of tree.birds) {
        if (!nextAction.has(bird.id)) nextAction.set(bird.id, snapshot.simTime + rng() * 2);
        if (snapshot.simTime < nextAction.get(bird.id)) continue;
        if (bird.state === 'perched') {
          world.unperchBird(bird.id);
        } else {
          const branch = allowed[Math.floor(rng() * allowed.length)];
          world.perchBird(bird.id, branch);
        }
        schedule(bird, snapshot.simTime);
      }
    }
  };
}

function analyzeHarmony(events, config) {
  const byDay = new Map();
  const starts = new Map();
  const add = (day, branchId, duration) => {
    if (!(duration > 0)) return;
    const counts = byDay.get(day) ?? { skeleton: 0, color: 0, outside: 0 };
    const key = !Number.isInteger(branchId) || branchId < 0 || branchId >= config.tree.branches.length
      ? 'outside' : branchId < config.harmony.skeletonBranches ? 'skeleton' : 'color';
    counts[key] += duration;
    byDay.set(day, counts);
  };
  for (const event of events) {
    if (event.type === 'perch') starts.set(event.birdId, event);
    if (event.type === 'unperch') {
      const start = starts.get(event.birdId);
      if (start) add(start.day, start.branchId, Math.max(0, event.time - start.time));
      starts.delete(event.birdId);
    }
    if (event.type === 'dawn') {
      for (const [birdId, start] of starts) {
        add(event.day - 1, start.branchId, Math.max(0, event.time - start.time));
        starts.set(birdId, { ...start, day: event.day, time: event.time });
      }
    }
  }
  const values = [...byDay.values()].map((counts) => harmonyScoreFromCounts(
    counts,
    config.harmony.harmonyWeights,
    config.harmony.harmonyRescaleFloor,
  )).filter((value) => value != null);
  return { values, mean: mean(values), variance: variance(values) };
}

function analyzeRhythm(events, bpm) {
  const secondsPerBeat = 60 / bpm;
  const offsets = events.filter((event) => event.type === 'perch').map((event) => {
    const beat = event.time / secondsPerBeat;
    return Math.abs(beat - Math.round(beat));
  });
  return { meanGridErrorBeats: mean(offsets), score: clamp01(1 - mean(offsets) * 2) };
}

function analyzeDensity(events, endTime, bpm, treeIds) {
  const binSeconds = (60 / bpm) / 2;
  const bins = Math.max(1, Math.ceil(endTime / binSeconds));
  const state = Object.fromEntries(treeIds.map((id) => [id, 0]));
  const ordered = events.filter((event) => event.type === 'perch' || event.type === 'unperch')
    .sort((a, b) => a.time - b.time);
  let cursor = 0;
  let conflict = 0;
  let blank = 0;
  let complementary = 0;
  for (let i = 0; i < bins; i += 1) {
    const until = (i + 1) * binSeconds;
    while (cursor < ordered.length && ordered[cursor].time < until) {
      const event = ordered[cursor++];
      state[event.treeId] += event.type === 'perch' ? 1 : -1;
      state[event.treeId] = Math.max(0, state[event.treeId]);
    }
    const active = Object.values(state).filter((count) => count > 0).length;
    if (active === 0) blank += 1;
    else if (active >= 3) conflict += 1;
    else complementary += 1;
  }
  return {
    conflictRatio: conflict / bins,
    blankRatio: blank / bins,
    score: complementary / bins,
  };
}

function analyzePitch(events, config = CONFIG) {
  const treeSpecies = Object.fromEntries((config.trees ?? []).map((tree) => [tree.id, tree.species]));
  const previous = new Map();
  const intervals = [];
  const bySpecies = {};
  for (const event of events.filter((entry) => entry.type === 'perch')) {
    const species = treeSpecies[event.treeId] ?? event.treeId;
    const note = noteFromBranch(event.branchId, event.chord, species);
    const before = previous.get(event.treeId);
    if (Number.isFinite(before)) {
      const interval = Math.abs(note - before);
      intervals.push(interval);
      if (!bySpecies[species]) bySpecies[species] = [];
      bySpecies[species].push(interval);
    }
    previous.set(event.treeId, note);
  }
  const summarizeIntervals = (list) => {
    const same = list.filter((value) => value === 0).length;
    const step = list.filter((value) => value > 0 && value <= 4).length;
    const leap = list.filter((value) => value > 4).length;
    const total = Math.max(1, list.length);
    const sameRatio = same / total;
    const stepRatio = step / total;
    const leapRatio = leap / total;
    const score = clamp01(1 - Math.abs(stepRatio - 0.55) - Math.max(0, leapRatio - 0.35));
    return { sameRatio, stepRatio, leapRatio, score };
  };
  const aggregate = summarizeIntervals(intervals);
  const perSpecies = Object.fromEntries(
    Object.entries(bySpecies).map(([species, list]) => [species, summarizeIntervals(list)]),
  );
  return { ...aggregate, perSpecies };
}

function summarize(tier, events, ecologyDays, snapshot, config) {
  const harmony = analyzeHarmony(events, config);
  const behaviorValues = ecologyDays.flatMap((day) => Object.values(day.trees).map((tree) => tree.score));
  const rhythm = analyzeRhythm(events, snapshot.bpm);
  const density = analyzeDensity(events, snapshot.simTime, snapshot.bpm, config.trees.map((tree) => tree.id));
  const pitch = analyzePitch(events, config);
  const melodyPitch = pitch.perSpecies?.melody;
  return {
    tier,
    eventCount: events.filter((event) => event.type === 'perch').length,
    days: ecologyDays.length,
    metrics: {
      harmonyMean: round(harmony.mean),
      harmonyVariance: round(harmony.variance),
      harmonyConsistency: round(clamp01(1 - harmony.variance * 4)),
      behaviorMean: round(mean(behaviorValues)),
      behaviorVariance: round(variance(behaviorValues)),
      rhythmScore: round(rhythm.score),
      rhythmGridErrorBeats: round(rhythm.meanGridErrorBeats),
      densityComplementarity: round(density.score),
      conflictRatio: round(density.conflictRatio),
      blankRatio: round(density.blankRatio),
      pitchMotionScore: round(pitch.score),
      sameRatio: round(pitch.sameRatio),
      stepRatio: round(pitch.stepRatio),
      leapRatio: round(pitch.leapRatio),
      // melody 专属音高运动（option-1 验收口径；聚合仍保留上方三键）
      melodyStepRatio: round(melodyPitch?.stepRatio ?? 0),
      melodyLeapRatio: round(melodyPitch?.leapRatio ?? 0),
      melodySameRatio: round(melodyPitch?.sameRatio ?? 0),
      melodyPitchMotionScore: round(melodyPitch?.score ?? 0),
    },
  };
}

export function runTier(tier, { seed = DEFAULT_SEED, days = DEFAULT_DAYS, config = CONFIG } = {}) {
  if (!['R', 'C', 'F'].includes(tier)) throw new Error(`unknown tier: ${tier}`);
  const rng = mulberry32(seed);
  // R 只保留和声菜单的五枝约束；去掉 bass 的物种低枝限制。其余两档使用原配置。
  const runtimeConfig = tier === 'R' ? structuredClone(config) : config;
  if (tier === 'R') {
    for (const species of Object.values(runtimeConfig.species)) delete species.allowedBranches;
  }
  const world = createWorld({ config: runtimeConfig, rng });
  const ecology = createEcologyTracker(world, runtimeConfig, { countManualAsRandom: tier === 'R' });
  let conductor = null;
  if (tier === 'F') {
    conductor = attachPipelineConductor(world, {
      config: runtimeConfig,
      rng,
      ecologyProvider: (treeId) => ecology.latest[treeId] ?? null,
    });
  }
  const chordAtEvent = (day) => conductor?.getChord()
    ?? chordFromFrame(frameForDay(day, runtimeConfig), runtimeConfig.harmony);
  const events = recordEvents(world, chordAtEvent);
  const randomStep = tier === 'R' ? installRandomDriver(world, rng, runtimeConfig) : null;
  const dt = 1 / runtimeConfig.sim.tickHz;
  const targetDay = days + 1;
  while (world.getSnapshot().day < targetDay) {
    randomStep?.();
    world.tick(dt);
  }
  return summarize(tier, events, ecology.days.slice(0, days), world.getSnapshot(), runtimeConfig);
}

export function runEvaluation(options = {}) {
  const tiers = Object.fromEntries(['R', 'C', 'F'].map((tier) => [tier, runTier(tier, options)]));
  return { seed: options.seed ?? DEFAULT_SEED, days: options.days ?? DEFAULT_DAYS, tiers };
}

export const PRIMARY_METRICS = Object.freeze([
  { key: 'harmonyMean', label: "H' 均值", higher: true },
  { key: 'harmonyConsistency', label: "H' 稳定度(1-4var)", higher: true },
  { key: 'behaviorMean', label: '行为分均值', higher: true },
  { key: 'rhythmScore', label: '节奏贴拍度', higher: true },
  { key: 'densityComplementarity', label: '声部密度互补度', higher: true },
  { key: 'pitchMotionScore', label: '音高运动合理性', higher: true },
]);

export function comparisonRows(result) {
  return PRIMARY_METRICS.map(({ key, label, higher }) => {
    const R = result.tiers.R.metrics[key];
    const C = result.tiers.C.metrics[key];
    const F = result.tiers.F.metrics[key];
    return {
      metric: label, R, C, F,
      FminusR: round(F - R),
      FminusC: round(F - C),
      ordered: higher ? F >= C && C >= R : F <= C && C <= R,
      inversion: F < C ? 'F<C' : C < R ? 'C<R' : '',
    };
  });
}
