import { CONFIG } from '../src/config.js';
import { createWorld } from '../src/world.js';
import { createDayObserver, createCrossVoiceObserver, deviationReport, scoreDay } from '../src/economy.js';
import { attachPipelineConductor, harmonyScoreFromCounts } from '../src/agent.js';
import { chordFromFrame, colorOptions, skeletonForSeason } from '../src/harmony.js';
import { noteFromBranch } from '../src/mapping.js';
import { sequenceRateForTree } from '../src/sequence.js';
// 可听分（T0.3）：真实发声路径只读引用——pad 走 mapping.padVoicingAssignments、
// bass 走 audio.bassArpPlan 的真实琶音。W1-A 可能改 src 签名：两处都按实际导出
// 防御式探测，签名缺失即回退 mapping 契约音（并在输出里标注 fallback），不硬编码。
import * as mappingApi from '../src/mapping.js';
import * as audioApi from '../src/audio.js';

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
    tension: config.harmony.tensionRange[0]
      + (config.harmony.tensionRange[1] - config.harmony.tensionRange[0]) * seasonDay / span,
  };
}

function createEcologyTracker(world, config, { countManualAsRandom = false } = {}) {
  const observers = Object.fromEntries(config.trees.map((tree) => [
    tree.id,
    createDayObserver(config.economy.prefs[tree.species], {
      beatsPerDay: config.tempo.barsPerDay * config.tempo.beatsPerBar,
      stepCount: config.tempo.barsPerDay * config.tempo.beatsPerBar,
    }),
  ]));
  const cvCfg = config.economy?.crossVoice ?? {};
  const crossVoice = createCrossVoiceObserver({
    treeIds: config.trees.map((tree) => tree.id),
    bpm: config.tempo.defaultBpm,
    binBeats: cvCfg.binBeats ?? 0.5,
    timeWeight: cvCfg.timeWeight ?? 0.7,
    registerWeight: cvCfg.registerWeight ?? 0.3,
    conflictThreshold: cvCfg.conflictThreshold ?? 0.5,
    blankThreshold: cvCfg.blankThreshold ?? 0.25,
    suppressCount: cvCfg.suppressCount ?? 1,
    stickyShareMin: cvCfg.stickyShareMin ?? 0.8,
    gateBeats: cvCfg.gateBeats ?? 0.5,
    denseVoiceThreshold: cvCfg.denseVoiceThreshold ?? 3,
    closeRegisterSemitones: cvCfg.closeRegisterSemitones ?? 5,
    suppressExclude: cvCfg.suppressExclude ?? [],
  });
  const treeSpecies = Object.fromEntries(config.trees.map((tree) => [tree.id, tree.species]));
  const treeRegister = Object.fromEntries(config.trees.map((tree) => [tree.id, tree.registerOffset ?? 0]));
  const latest = {};
  const days = [];
  const observedCause = (event) => countManualAsRandom && event.cause === 'manual'
    ? undefined : event.cause;

  function annotateMidi(event) {
    // harness 事件无 chord；无 midi 时 register 分量豁免，总分=时间错峰（对齐评测器主轴）。
    if (event.type === 'unperch' || event.event === 'unperch') {
      return { ...event, event: event.event ?? 'unperch' };
    }
    const species = treeSpecies[event.treeId];
    const chord = event.chord;
    let midi = null;
    if (chord && Number.isInteger(event.branchId)) {
      midi = noteFromBranch(event.branchId, chord, species) + (treeRegister[event.treeId] ?? 0);
    }
    return { ...event, event: event.event ?? 'perch', midi };
  }

  world.on('perch', (event) => {
    observers[event.treeId]?.feed({
      ...event, event: 'perch', cause: observedCause(event),
    });
    crossVoice.feed(annotateMidi({ ...event, type: 'perch' }));
  });
  world.on('unperch', (event) => {
    observers[event.treeId]?.feed({
      ...event,
      event: 'unperch',
      cause: observedCause(event),
      dwellTime: Number.isFinite(event.dwellBeats) ? event.dwellBeats : event.dwellTime,
    });
    crossVoice.feed({ ...event, event: 'unperch', type: 'unperch' });
  });
  world.onBeforeDawn(({ stats }) => {
    const snap = world.getSnapshot();
    const dayCross = crossVoice.finishDay({
      endTime: snap.simTime,
      dayStart: snap.simTime - snap.dayLength,
      dayLength: snap.dayLength,
      bpm: snap.bpm,
    });
    const perTree = {};
    for (const tree of config.trees) {
      const observed = {
        ...observers[tree.id].finishDay({
          dayStart: snap.simTime - snap.dayLength,
          endTime: snap.simTime,
        }),
        crossVoice: dayCross.treeScores[tree.id] ?? dayCross.crossVoice,
      };
      const prefs = config.economy.prefs[tree.species];
      const report = deviationReport(observed, prefs);
      const entry = {
        branchChangesPerLoop: observed.branchChanges,
        sequenceOnsetCount: observed.onsetCount,
        intervalRegularity: observed.intervalRegularity,
        meanDwellBeats: observed.meanDwell,
        clusterSize: observed.cohortSize,
        clusterPeak: observed.cohortPeak,
        crossVoice: dayCross.treeScores[tree.id] ?? dayCross.crossVoice,
        crossVoiceHint: dayCross.biasHints[tree.id] ?? 'hold',
        crossVoiceConflictRatio: dayCross.conflictRatio,
        crossVoiceBlankRatio: dayCross.blankRatio,
        score: scoreDay(observed, prefs),
        deviation: {
          branchChanges: { direction: report.branchChanges, amount: report.magnitude.branchChanges },
          onsetCount: { direction: report.onsetCount, amount: report.magnitude.onsetCount },
          intervalRegularity: {
            direction: report.intervalRegularity, amount: report.magnitude.intervalRegularity,
          },
          meanDwell: { direction: report.meanDwell, amount: report.magnitude.meanDwell },
          cohortSize: { direction: report.cohortSize, amount: report.magnitude.cohortSize },
          crossVoice: { direction: report.crossVoice, amount: report.magnitude.crossVoice },
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
  )).filter((value) => value != null);
  return { values, mean: mean(values), variance: variance(values) };
}

function analyzeRhythm(events, bpm, config = CONFIG) {
  const secondsPerBeat = 60 / bpm;
  const offsets = events.filter((event) => event.type === 'perch').map((event) => {
    if (Number.isInteger(event.stepIndex) && Number.isInteger(event.stepCount) && event.stepCount > 0) {
      const rate = sequenceRateForTree(event.treeId, config);
      const phase = Number(event.phase) * rate;
      const position = (((phase % 1) + 1) % 1) * event.stepCount;
      const delta = Math.abs(position - event.stepIndex);
      return Math.min(delta, event.stepCount - delta);
    }
    const beat = event.time / secondsPerBeat;
    return Math.abs(beat - Math.round(beat));
  });
  return { meanGridErrorBeats: mean(offsets), score: clamp01(1 - mean(offsets) * 2) };
}

function analyzeDensity(events, endTime, bpm, config) {
  const treeIds = config.trees.map((tree) => tree.id);
  const treeById = Object.fromEntries(config.trees.map((tree) => [tree.id, tree]));
  const cv = config.economy?.crossVoice ?? {};
  const observer = createCrossVoiceObserver({
    treeIds,
    bpm,
    binBeats: cv.binBeats ?? 0.5,
    gateBeats: cv.gateBeats ?? 0.5,
    timeWeight: cv.timeWeight ?? 0.7,
    registerWeight: cv.registerWeight ?? 0.3,
    denseVoiceThreshold: cv.denseVoiceThreshold ?? 3,
    closeRegisterSemitones: cv.closeRegisterSemitones ?? 5,
  });
  observer.feed(events.filter((event) => event.type === 'perch' || event.type === 'unperch')
    .map((event) => {
      if (event.type !== 'perch') return { ...event, event: 'unperch' };
      const tree = treeById[event.treeId];
      const midi = event.chord && tree && Number.isInteger(event.branchId)
        ? noteFromBranch(event.branchId, event.chord, tree.species) + (tree.registerOffset ?? 0)
        : null;
      return { ...event, event: 'perch', midi };
    }));
  const day = observer.finishDay({ dayStart: 0, dayLength: endTime, bpm });
  return {
    conflictRatio: day.conflictRatio,
    blankRatio: day.blankRatio,
    score: day.crossVoice ?? 0,
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
    // melody 是单音句法，按树读取时间序列；其余复音声部按鸟追踪，避免把和弦纵向
    // 间隔误判为同一旋律大跳。
    const voiceKey = species === 'melody'
      ? event.treeId : `${event.treeId}:${event.birdId ?? 'legacy'}`;
    const before = previous.get(voiceKey);
    if (Number.isFinite(before)) {
      const interval = Math.abs(note - before);
      intervals.push(interval);
      if (!bySpecies[species]) bySpecies[species] = [];
      bySpecies[species].push(interval);
    }
    previous.set(voiceKey, note);
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

// ---------------------------------------------------------------------------
// T0.3 可听分（audible）与具身因果损失（embodiment loss）
// 物理列维持现状（analyzeHarmony/analyzePitch 的 noteFromBranch 口径）；
// 可听列采集真实发声：pad=mapping.padVoicingAssignments 分派音、bass=
// audio.bassArpPlan 琶音实际音（只在有 bass 栖鸟的窗口内，与引擎一致）、
// melody/texture=现状 mapping 契约音（noteFromBranch + registerOffset）。
// W1-A 可能改 src 签名：pad/bass 两处按实际导出防御式探测，签名缺失即回退
// mapping 契约音（结果 audibleModes 标注 contract-fallback），不硬编码签名。
// ---------------------------------------------------------------------------

const pcOf = (midi) => ((Math.round(midi) % 12) + 12) % 12;

function treeSpeciesOf(event, config) {
  return config.trees.find((tree) => tree.id === event.treeId)?.species ?? event.treeId;
}

// 事件流 → 逐鸟发声段（dawn 跨界切段续开），每段带 mapping 契约音与当日 chord。
function contractSegments(events, config, chordForDay) {
  const treeRegister = Object.fromEntries(config.trees.map((tree) => [tree.id, tree.registerOffset ?? 0]));
  const segments = [];
  const open = new Map();
  const close = (birdId, time) => {
    const seg = open.get(birdId);
    if (!seg) return;
    open.delete(birdId);
    seg.end = Math.max(seg.start, time);
    if (seg.end > seg.start) segments.push(seg);
  };
  const contractOf = (seg, chord) => noteFromBranch(seg.branchId, chord, seg.species)
    + (treeRegister[seg.treeId] ?? 0);
  for (const event of events) {
    if (event.type === 'perch') {
      close(event.birdId, event.time);
      const species = treeSpeciesOf(event, config);
      const seg = {
        birdId: event.birdId, treeId: event.treeId, species,
        branchId: event.branchId, day: event.day,
        start: event.time, end: event.time, chord: event.chord,
      };
      seg.midiContract = contractOf(seg, event.chord);
      open.set(event.birdId, seg);
    } else if (event.type === 'unperch') {
      close(event.birdId, event.time);
    } else if (event.type === 'dawn') {
      for (const [birdId, seg] of [...open]) {
        seg.end = Math.max(seg.start, event.time);
        if (seg.end > seg.start) segments.push(seg);
        const chord = chordForDay(event.day);
        const next = {
          ...seg, day: event.day, start: event.time, end: event.time, chord,
        };
        next.midiContract = contractOf(next, chord);
        open.set(birdId, next);
      }
    }
  }
  const lastTime = events.reduce((t, e) => Math.max(t, e.time ?? 0), 0);
  for (const birdId of [...open.keys()]) close(birdId, lastTime);
  return segments;
}

// pad 可听流：沿时间轴重放「栖鸟集合 → voicing 分派」（与引擎同：跨日延续 previous，
// 换季不自动重分——mid 保持到下一次栖鸟变动，这正是可听 vs 物理要量的偏差）。
function padAudibleSegments(events, config, chordForDay) {
  const assign = typeof mappingApi.padVoicingAssignments === 'function'
    ? mappingApi.padVoicingAssignments : null;
  const padTree = config.trees.find((tree) => tree.species === 'pad');
  const register = padTree?.registerOffset ?? 0;
  const contractOf = (branchId, chord) => noteFromBranch(branchId, chord, 'pad') + register;
  if (!assign) {
    return {
      segments: contractSegments(events, config, chordForDay)
        .filter((seg) => seg.species === 'pad')
        .map((seg) => ({ ...seg, midiAudible: seg.midiContract })),
      fallback: true,
    };
  }
  const timbre = config.audio?.timbres?.pad ?? {};
  const [minMidi, maxMidi] = timbre.voicingRange ?? [52, 76];
  const out = [];
  const perched = new Map(); // birdId -> { branchId }
  let currentMidi = new Map();
  let previous = new Map();
  let windowStart = 0;
  let windowDay = 1;
  const flush = (time) => {
    for (const [birdId, info] of perched) {
      const midi = currentMidi.get(birdId);
      if (midi == null || windowStart >= time) continue;
      const chord = chordForDay(windowDay);
      out.push({
        birdId, treeId: padTree?.id ?? 'pad', species: 'pad', day: windowDay,
        branchId: info.branchId, start: windowStart, end: time, chord,
        midiAudible: midi, midiContract: contractOf(info.branchId, chord),
      });
    }
  };
  const revoice = (day) => {
    const entries = [...perched.entries()].map(([birdId, info]) => ({ birdId, branchId: info.branchId }));
    const rows = assign(entries, chordForDay(day), {
      registerOffset: register, minMidi, maxMidi, previous,
    });
    currentMidi = new Map(rows.map((row) => [row.birdId, row.midi]));
    previous = new Map(rows.map((row) => [row.birdId, { midi: row.midi, role: row.role }]));
  };
  for (const event of events) {
    if (event.type === 'dawn') {
      flush(event.time);
      windowStart = event.time;
      windowDay = event.day;
      continue;
    }
    if (treeSpeciesOf(event, config) !== 'pad') continue;
    if (event.type !== 'perch' && event.type !== 'unperch') continue;
    flush(event.time);
    if (event.type === 'perch') {
      perched.set(event.birdId, { branchId: event.branchId });
    } else {
      perched.delete(event.birdId);
      currentMidi.delete(event.birdId);
      previous.delete(event.birdId);
    }
    if (perched.size) revoice(windowDay);
    windowStart = event.time;
  }
  const lastTime = events.reduce((t, e) => Math.max(t, e.time ?? 0), 0);
  flush(lastTime);
  return { segments: out.filter((seg) => seg.end > seg.start), fallback: false };
}

// bass 可听流：按引擎真实路径逐模式回放——
// pulse（W1-A 后）：每只栖鸟在自己的物理枝音上按张力脉冲（audio.bassPulsePlan）；
// arp（W1-A 前旧世界）：bassArpPlan 骨架低三音琶音；
// fallback：两者都缺失 → mapping 契约音。按实际导出探测，不硬编码。
// anchors(day)：当日起点秒（day1=0，其后=前一 dawn 时刻），由 audibleAnalysis 注入。
function bassAudibleSegments(contracts, config, chordForDay, tensionForDay, bpm, startPhase, anchors) {
  const bassContracts = contracts.filter((seg) => seg.species === 'bass');
  const pulse = typeof audioApi.bassPulsePlan === 'function' ? audioApi.bassPulsePlan : null;
  const arp = typeof audioApi.bassArpPlan === 'function' ? audioApi.bassArpPlan : null;
  if (!pulse && !arp) {
    return {
      segments: bassContracts.map((seg) => ({ ...seg, midiAudible: seg.midiContract })),
      fallback: true,
      mode: 'contract-fallback',
    };
  }
  const timbre = config.audio?.timbres?.bass ?? {};
  const register = config.trees.find((tree) => tree.species === 'bass')?.registerOffset ?? -12;
  const density = clamp01(Number(timbre.pulseDensityMax ?? timbre.arpDensityMax ?? 1));
  const lowStep = Number(timbre.lowTensionStepBeats ?? 1) || 1;
  const highStep = lowStep + (Number(timbre.highTensionStepBeats ?? 0.5) - lowStep) * density;
  const split = Number(timbre.tensionDensitySplit ?? 0.55);
  const secondsPerBeat = 60 / Math.max(1, Number(bpm) || 60);
  const dayLengthSeconds = config.tempo.barsPerDay * config.tempo.beatsPerBar * secondsPerBeat;

  if (pulse) { // 逐栖鸟段：该鸟自己的枝音在段内按步长脉冲（与引擎 scheduleBassPulses 同构）
    const out = [];
    for (const seg of bassContracts) {
      const tension = Number(tensionForDay?.(seg.day)) || 0;
      const stepBeats = tension >= split ? highStep : lowStep;
      const phase = Math.min(1, Math.max(0, (seg.start - anchors(seg.day)) / dayLengthSeconds));
      const notes = pulse({
        midi: seg.midiContract,
        bpm: Number(bpm) || 60,
        phase,
        barsPerDay: config.tempo.barsPerDay,
        beatsPerBar: config.tempo.beatsPerBar,
        tension,
        lowStepBeats: lowStep,
        highStepBeats: highStep,
        tensionSplit: split,
      });
      for (const note of notes) {
        const start = anchors(seg.day) + note.offsetSeconds;
        const end = start + stepBeats * secondsPerBeat;
        const s = Math.max(start, seg.start);
        const e = Math.min(end, seg.end);
        if (e <= s) continue;
        out.push({
          birdId: seg.birdId, treeId: seg.treeId, species: 'bass', day: seg.day,
          branchId: seg.branchId, start: s, end: e, chord: seg.chord,
          midiAudible: note.midi, midiContract: seg.midiContract,
        });
      }
    }
    return { segments: out, fallback: false, mode: 'pulse' };
  }

  // 旧琶音路径（pre-W1-A）：按日算骨架低三音计划，裁到「任一 bass 鸟栖着」的窗口并集。
  const windows = bassContracts
    .map((seg) => [seg.start, seg.end])
    .sort((a, b) => a[0] - b[0])
    .reduce((merged, [s, e]) => {
      const last = merged[merged.length - 1];
      if (last && s <= last[1] + 1e-9) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
      return merged;
    }, []);
  if (!windows.length) return { segments: [], fallback: false, mode: 'arp' };
  const contractAt = (time) => bassContracts
    .find((seg) => seg.start <= time && seg.end > time)?.midiContract;
  const out = [];
  const days = new Set(bassContracts.map((seg) => seg.day));
  for (const day of days) {
    const chord = chordForDay(day);
    if (!chord?.notes?.length) continue;
    const phase = day === 1 ? startPhase : 0;
    const tension = Number(tensionForDay?.(day)) || 0;
    const stepBeats = tension >= split ? highStep : lowStep;
    const notes = arp({
      chordNotes: chord.notes,
      registerOffset: register,
      skeletonBranches: config.harmony.skeletonBranches,
      pattern: timbre.arpPattern ?? [0, 1, 2, 1],
      bpm: Number(bpm) || 60,
      phase,
      barsPerDay: config.tempo.barsPerDay,
      beatsPerBar: config.tempo.beatsPerBar,
      tension,
      lowStepBeats: lowStep,
      highStepBeats: highStep,
      tensionSplit: split,
    });
    for (const note of notes) {
      const start = anchors(day) + note.offsetSeconds;
      const end = start + stepBeats * secondsPerBeat;
      for (const [ws, we] of windows) {
        const s = Math.max(start, ws);
        const e = Math.min(end, we);
        if (e <= s) continue;
        out.push({
          birdId: null, treeId: 'bass', species: 'bass', day,
          branchId: null, start: s, end: e, chord,
          midiAudible: note.midi,
          midiContract: contractAt(s) ?? note.midi,
        });
      }
    }
  }
  return { segments: out, fallback: false, mode: 'arp' };
}

function analyzeAudibleHarmony(segments, config) {
  const k = config.harmony.skeletonBranches;
  const byDay = new Map();
  for (const seg of segments) {
    const notes = seg.chord?.notes ?? [];
    if (!notes.length || !Number.isFinite(seg.midiAudible)) continue;
    const skeletonPcs = new Set(notes.slice(0, k).map(pcOf));
    const colorPcs = new Set(notes.slice(k).map(pcOf));
    const pc = pcOf(seg.midiAudible);
    const key = skeletonPcs.has(pc) ? 'skeleton' : colorPcs.has(pc) ? 'color' : 'outside';
    const counts = byDay.get(seg.day) ?? { skeleton: 0, color: 0, outside: 0 };
    counts[key] += seg.end - seg.start;
    byDay.set(seg.day, counts);
  }
  const values = [...byDay.values()].map((counts) => harmonyScoreFromCounts(
    counts,
    config.harmony.harmonyWeights,
  )).filter((value) => value != null);
  return { mean: mean(values), variance: variance(values) };
}

function analyzeAudiblePitch(segments) {
  const byTree = new Map();
  for (const seg of [...segments].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (!Number.isFinite(seg.midiAudible)) continue;
    if (!byTree.has(seg.treeId)) byTree.set(seg.treeId, []);
    byTree.get(seg.treeId).push(seg.midiAudible);
  }
  const intervals = [];
  for (const midis of byTree.values()) {
    for (let i = 1; i < midis.length; i += 1) intervals.push(Math.abs(midis[i] - midis[i - 1]));
  }
  const same = intervals.filter((v) => v === 0).length;
  const step = intervals.filter((v) => v > 0 && v <= 4).length;
  const leap = intervals.filter((v) => v > 4).length;
  const total = Math.max(1, intervals.length);
  const stepRatio = step / total;
  const leapRatio = leap / total;
  return {
    sameRatio: same / total,
    stepRatio,
    leapRatio,
    score: clamp01(1 - Math.abs(stepRatio - 0.55) - Math.max(0, leapRatio - 0.35)),
  };
}

function analyzeEmbodimentLoss(segments) {
  const buckets = new Map();
  let total = 0;
  let deviated = 0;
  let weight = 0;
  for (const seg of segments) {
    if (!Number.isFinite(seg.midiAudible) || !Number.isFinite(seg.midiContract)) continue;
    const w = seg.end - seg.start;
    if (!(w > 0)) continue;
    const diff = Math.abs(seg.midiAudible - seg.midiContract);
    if (!buckets.has(seg.species)) buckets.set(seg.species, { total: 0, deviated: 0, weight: 0 });
    const bucket = buckets.get(seg.species);
    bucket.total += diff * w;
    bucket.weight += w;
    if (diff >= 1) bucket.deviated += w;
    total += diff * w;
    weight += w;
    if (diff >= 1) deviated += w;
  }
  const perSpecies = Object.fromEntries([...buckets.entries()].map(([species, bucket]) => [species, {
    meanSemitones: bucket.weight > 0 ? bucket.total / bucket.weight : 0,
    deviationShare: bucket.weight > 0 ? bucket.deviated / bucket.weight : 0,
  }]));
  return {
    meanSemitones: weight > 0 ? total / weight : 0,
    deviationShare: weight > 0 ? deviated / weight : 0,
    perSpecies,
  };
}

// 汇总可听列：返回 { segments, harmony, pitch, loss, modes }。
function audibleAnalysis(events, config, { chordForDay, tensionForDay, bpm, startPhase = 0 }) {
  // dawn 锚：day→当日起点秒（dawn 事件在当日开始处发射）。
  const dawnTimes = new Map([[1, 0]]);
  for (const event of events) if (event.type === 'dawn') dawnTimes.set(event.day, event.time);
  const anchors = (day) => dawnTimes.get(day) ?? 0;
  const contracts = contractSegments(events, config, chordForDay);
  const pad = padAudibleSegments(events, config, chordForDay);
  const bass = bassAudibleSegments(contracts, config, chordForDay, tensionForDay, bpm, startPhase, anchors);
  const others = contracts
    .filter((seg) => seg.species !== 'pad' && seg.species !== 'bass')
    .map((seg) => ({ ...seg, midiAudible: seg.midiContract }));
  const segments = [...pad.segments, ...bass.segments, ...others];
  return {
    segments,
    harmony: analyzeAudibleHarmony(segments, config),
    pitch: analyzeAudiblePitch(segments),
    loss: analyzeEmbodimentLoss(segments),
    modes: {
      pad: pad.fallback ? 'contract-fallback' : 'voicing',
      bass: bass.mode ?? (bass.fallback ? 'contract-fallback' : 'arp'),
      melody: 'contract',
      texture: 'contract',
    },
  };
}

function summarize(tier, events, ecologyDays, snapshot, config, providers = {}) {
  const harmony = analyzeHarmony(events, config);
  const behaviorValues = ecologyDays.flatMap((day) => Object.values(day.trees).map((tree) => tree.score));
  const rhythm = analyzeRhythm(events, snapshot.bpm, config);
  const density = analyzeDensity(events, snapshot.simTime, snapshot.bpm, config);
  const pitch = analyzePitch(events, config);
  const melodyPitch = pitch.perSpecies?.melody;
  const bassTreeId = config.trees.find((tree) => tree.species === 'bass')?.id;
  const bassDays = bassTreeId
    ? ecologyDays.map((day) => day.trees[bassTreeId]).filter(Boolean) : [];
  // T0.3 可听列：providers 缺省时全部给 0（保持 metrics 全为有限数）。
  const audible = providers.chordForDay
    ? audibleAnalysis(events, config, providers)
    : { harmony: { mean: 0, variance: 0 }, pitch: { score: 0, sameRatio: 0, stepRatio: 0, leapRatio: 0 },
      loss: { meanSemitones: 0, deviationShare: 0, perSpecies: {} }, modes: {} };
  const embodimentFlat = {};
  for (const tree of config.trees) {
    const bucket = audible.loss.perSpecies?.[tree.species]
      ?? { meanSemitones: 0, deviationShare: 0 };
    const label = tree.species[0].toUpperCase() + tree.species.slice(1);
    embodimentFlat[`embodimentMean${label}`] = round(bucket.meanSemitones);
    embodimentFlat[`embodimentShare${label}`] = round(bucket.deviationShare);
  }
  return {
    tier,
    eventCount: events.filter((event) => event.type === 'perch').length,
    days: ecologyDays.length,
    audibleModes: audible.modes,
    metrics: {
      harmonyMean: round(harmony.mean),
      harmonyVariance: round(harmony.variance),
      harmonyConsistency: round(clamp01(1 - harmony.variance * 4)),
      behaviorMean: round(mean(behaviorValues)),
      behaviorVariance: round(variance(behaviorValues)),
      bassOnsetCountMean: round(mean(bassDays.map((day) => day.sequenceOnsetCount))),
      bassIntervalRegularityMean: round(mean(bassDays.map((day) => day.intervalRegularity))),
      bassCohortP90Mean: round(mean(bassDays.map((day) => day.clusterSize))),
      bassCohortPeakMean: round(mean(bassDays.map((day) => day.clusterPeak))),
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
      // T0.3 可听口径（真实发声）
      harmonyMeanAudible: round(audible.harmony.mean),
      harmonyConsistencyAudible: round(clamp01(1 - audible.harmony.variance * 4)),
      pitchMotionScoreAudible: round(audible.pitch.score),
      sameRatioAudible: round(audible.pitch.sameRatio),
      stepRatioAudible: round(audible.pitch.stepRatio),
      leapRatioAudible: round(audible.pitch.leapRatio),
      // 具身因果损失：可听 vs mapping 契约（时长加权平均半音差 / 偏差时长占比）
      embodimentLossMeanSemitones: round(audible.loss.meanSemitones),
      embodimentDeviationShare: round(audible.loss.deviationShare),
      ...embodimentFlat,
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
  // T0.3：dawn 锚定当日 chord/tension（conductor 在 beforeDawn 建新 frame，此监听在后注册，
  // 读到的是当日新值；F 档用 conductor 真值，C/R 档回退 frameForDay 公式）。
  const chordByDay = new Map();
  const tensionByDay = new Map();
  world.on('dawn', (event) => {
    const frame = conductor?.getFrame?.();
    chordByDay.set(event.day, conductor?.getChord?.()
      ?? chordFromFrame(frameForDay(event.day, runtimeConfig), runtimeConfig.harmony));
    tensionByDay.set(event.day, Number.isFinite(frame?.tension)
      ? frame.tension : frameForDay(event.day, runtimeConfig).tension);
  });
  const randomStep = tier === 'R' ? installRandomDriver(world, rng, runtimeConfig) : null;
  const dt = 1 / runtimeConfig.sim.tickHz;
  const targetDay = days + 1;
  while (world.getSnapshot().day < targetDay) {
    randomStep?.();
    world.tick(dt);
  }
  const providers = {
    chordForDay: (day) => chordByDay.get(day)
      ?? chordFromFrame(frameForDay(day, runtimeConfig), runtimeConfig.harmony),
    tensionForDay: (day) => tensionByDay.get(day) ?? frameForDay(day, runtimeConfig).tension,
    bpm: world.getSnapshot().bpm,
    startPhase: runtimeConfig.sim.startPhase ?? 0,
  };
  return summarize(tier, events, ecology.days.slice(0, days), world.getSnapshot(), runtimeConfig, providers);
}

export function runEvaluation(options = {}) {
  const tiers = Object.fromEntries(['R', 'C', 'F'].map((tier) => [tier, runTier(tier, options)]));
  return { seed: options.seed ?? DEFAULT_SEED, days: options.days ?? DEFAULT_DAYS, tiers };
}

// R 是无机制随机诊断，不要求它在每个统计量上都最差；C 是规则执行基线。
// 闸门只约束 F 能归因控制的机制改善，或绝对安全/质量下限。
export const EVALUATION_GATES = Object.freeze([
  { key: 'harmonyMean', label: 'H 均值不退化', mode: 'delta', threshold: -0.03, expectation: 'F≥C−0.03' },
  { key: 'harmonyConsistency', label: 'H 稳定度不退化', mode: 'delta', threshold: -0.01, expectation: 'F≥C−0.01' },
  { key: 'behaviorMean', label: '行为健康下限', mode: 'floor', threshold: 0.70, expectation: 'F≥0.70' },
  { key: 'rhythmScore', label: 'Sequence 贴拍改善', mode: 'delta', threshold: 0.15, expectation: 'F−C≥0.15' },
  { key: 'densityComplementarity', label: '合奏互补下限', mode: 'floor', threshold: 0.55, expectation: 'F≥0.55' },
  { key: 'conflictRatio', label: '近音区冲突上限', mode: 'ceiling', threshold: 0.12, expectation: 'F≤0.12' },
  { key: 'blankRatio', label: '合奏空白上限', mode: 'ceiling', threshold: 0.45, expectation: 'F≤0.45' },
  { key: 'melodyPitchMotionScore', label: '旋律运动下限', mode: 'floor', threshold: 0.65, expectation: 'F≥0.65' },
  { key: 'embodimentLossMeanSemitones', label: '可听具身损失上限', mode: 'ceiling', threshold: 0.75, expectation: 'F≤0.75半音' },
]);

// 兼容旧导入名；语义已从“全指标单调排序”迁为机制闸门。
export const PRIMARY_METRICS = EVALUATION_GATES;

export function comparisonRows(result) {
  return EVALUATION_GATES.map(({ key, label, mode, threshold, expectation }) => {
    const R = result.tiers.R.metrics[key];
    const C = result.tiers.C.metrics[key];
    const F = result.tiers.F.metrics[key];
    const passed = mode === 'delta' ? F - C >= threshold
      : mode === 'ceiling' ? F <= threshold : F >= threshold;
    return {
      metric: label, R, C, F,
      FminusR: round(F - R),
      FminusC: round(F - C),
      expectation,
      passed,
      // 兼容调用方；ordered 现在表示“机制闸门通过”。
      ordered: passed,
      inversion: passed ? '' : expectation,
    };
  });
}
