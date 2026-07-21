// Phase 1.7 生态计分核心。
// 接线：订阅 world 的 `*` 事件并逐条 observer.feed(event)，黎明/日终调用
// observer.finishDay() 取得刚结束一天的观测；黄昏复盘把 scoreDay 与
// deviationReport 一起注入 agent。模块不读取 config，也不发明任何资源状态。
//
// 驻留口径（与 world.finalizeDayStats 统一，T40）：
// meanDwell（拍）= 当日驻留样本的算术平均。
// 样本 = 日内离枝且 dwell>0（cause=hop|user|sequence；settle/归巢不计）
//      + 日终仍栖的开放样本（由 finishDay({ openDwellBeats }) 注入，或无离枝且仍有栖鸟时
//        按「全天连续栖枝」≈ beatsPerDay 记——杜绝「不动=0拍=0分」激励倒挂）。
//
// 响度失衡（loudnessBalance，R1）：
// 值 = 相对当日最响声部的电平 dB（20·log10(rms/maxRms)）。
// 无电平数据 → null 豁免（权重归零重归一；不得当 0 分——同 H null 透传教训）。
//
// 跨声部生态位（crossVoice，Track B）：
// 值 = 起音/gate 的时间互补分 × timeWeight + 音区互补分 × registerWeight（[0,1]）。
// 持续栖息不再被当成全日占用；3–4 轨只在同 gate 且音区过近时算冲突。
// 全日无 perch → null 豁免（不得当错峰满分或零分污染）。

import { jungleRoleDiversity } from './jungle.js';

const BEHAVIOR_METRICS = Object.freeze([
  'branchChanges', 'onsetCount', 'intervalRegularity', 'roleDiversity', 'meanDwell', 'cohortSize',
]);
const METRICS = Object.freeze([...BEHAVIOR_METRICS, 'loudnessBalance', 'crossVoice']);
const DEFAULT_BEATS_PER_DAY = 16; // tempo.barsPerDay × beatsPerBar（1 循环）
// 响度默认带：锚=当日最响 RMS；过静 <-24dB、过响 >-3dB（kimi2 / r2-retest §5）。
const DEFAULT_LOUDNESS_BAND = Object.freeze({ lo: -24, hi: 0, slope: 1 / 12, weight: 0.5 });
// 跨声部默认带：奖励起音覆盖与音区互补；权重中等偏强。
const DEFAULT_CROSS_VOICE_BAND = Object.freeze({ lo: 0.05, hi: 1, slope: 1 / 0.2, weight: 0.75 });
const DEFAULT_CROSS_VOICE_BLEND = Object.freeze({ timeWeight: 0.7, registerWeight: 0.3 });
const DEFAULT_ONSET_COUNT_BAND = Object.freeze({ lo: 0, hi: 16, slope: 1 / 4, weight: 0 });
const DEFAULT_INTERVAL_REGULARITY_BAND = Object.freeze({ lo: 0, hi: 1, slope: 1, weight: 0 });
const DEFAULT_ROLE_DIVERSITY_BAND = Object.freeze({ lo: 0, hi: 1, slope: 1, weight: 0 });
const SILENCE_FLOOR_DB = -120;
const EXEMPT_METRICS = new Set(['loudnessBalance', 'crossVoice']);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function withEconomyExtras(prefs) {
  return {
    ...prefs,
    onsetCount: {
      ...DEFAULT_ONSET_COUNT_BAND, ...(prefs.onsetCount ?? {}),
      weight: prefs.onsetCount?.weight ?? prefs.weights?.onsetCount ?? DEFAULT_ONSET_COUNT_BAND.weight,
    },
    intervalRegularity: {
      ...DEFAULT_INTERVAL_REGULARITY_BAND, ...(prefs.intervalRegularity ?? {}),
      weight: prefs.intervalRegularity?.weight
        ?? prefs.weights?.intervalRegularity ?? DEFAULT_INTERVAL_REGULARITY_BAND.weight,
    },
    roleDiversity: {
      ...DEFAULT_ROLE_DIVERSITY_BAND, ...(prefs.roleDiversity ?? {}),
      weight: prefs.roleDiversity?.weight
        ?? prefs.weights?.roleDiversity ?? DEFAULT_ROLE_DIVERSITY_BAND.weight,
    },
    loudnessBalance: { ...DEFAULT_LOUDNESS_BAND, ...(prefs.loudnessBalance ?? {}) },
    crossVoice: { ...DEFAULT_CROSS_VOICE_BAND, ...(prefs.crossVoice ?? {}) },
    weights: {
      ...prefs.weights,
      onsetCount: prefs.weights?.onsetCount ?? DEFAULT_ONSET_COUNT_BAND.weight,
      intervalRegularity: prefs.weights?.intervalRegularity ?? DEFAULT_INTERVAL_REGULARITY_BAND.weight,
      roleDiversity: prefs.weights?.roleDiversity ?? DEFAULT_ROLE_DIVERSITY_BAND.weight,
      loudnessBalance: prefs.weights?.loudnessBalance ?? DEFAULT_LOUDNESS_BAND.weight,
      crossVoice: prefs.weights?.crossVoice ?? DEFAULT_CROSS_VOICE_BAND.weight,
    },
  };
}

// §2 四树 profile，单位统一为每循环换枝次数与驻留拍数。开放上界用
// hi=Infinity 表示：过长不扣分，只惩罚低于下沿。
export const DEFAULT_PREFS = deepFreeze({
  melody: withEconomyExtras({
    branchChanges: { lo: 8, hi: 16, slope: 1 / 8 },
    meanDwell: { lo: 0.5, hi: 2, slope: 2 / 3 },
    cohortSize: { lo: 1, hi: 1, slope: 1 },
    weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1 },
  }),
  pad: withEconomyExtras({
    branchChanges: { lo: 0, hi: 1, slope: 1 / 2 },
    meanDwell: { lo: 8, hi: Number.POSITIVE_INFINITY, slope: 1 / 8 },
    cohortSize: { lo: 1, hi: 2, slope: 1 },
    weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1 },
  }),
  bass: withEconomyExtras({
    branchChanges: { lo: 0, hi: 0, slope: 1 },
    onsetCount: { lo: 2, hi: 5, slope: 1 / 2 },
    intervalRegularity: { lo: 0.55, hi: 1, slope: 1 / 0.55 },
    meanDwell: { lo: 3, hi: Number.POSITIVE_INFINITY, slope: 1 / 4 },
    cohortSize: { lo: 1, hi: 3, slope: 1 },
    weights: {
      branchChanges: 0, onsetCount: 0.55, intervalRegularity: 0.45,
      meanDwell: 1, cohortSize: 1,
    },
  }),
  texture: withEconomyExtras({
    branchChanges: { lo: 4, hi: 8, slope: 1 / 4 },
    onsetCount: { lo: 2, hi: 4, slope: 1 / 2 },
    intervalRegularity: { lo: 0.5, hi: 1, slope: 2 },
    roleDiversity: { lo: 2 / 3, hi: 1, slope: 3 },
    meanDwell: { lo: 1, hi: 4, slope: 1 / 3 },
    cohortSize: { lo: 1, hi: 1, slope: 1 },
    weights: {
      branchChanges: 0, onsetCount: 0.35, intervalRegularity: 0.35, roleDiversity: 0.3,
      meanDwell: 1, cohortSize: 1,
    },
  }),
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function bandDefaults(metric) {
  if (metric === 'onsetCount') return DEFAULT_ONSET_COUNT_BAND;
  if (metric === 'intervalRegularity') return DEFAULT_INTERVAL_REGULARITY_BAND;
  if (metric === 'roleDiversity') return DEFAULT_ROLE_DIVERSITY_BAND;
  if (metric === 'loudnessBalance') return DEFAULT_LOUDNESS_BAND;
  if (metric === 'crossVoice') return DEFAULT_CROSS_VOICE_BAND;
  return null;
}

function bandFor(prefs, metric) {
  const band = prefs?.[metric] ?? {};
  const defaults = bandDefaults(metric);
  const lo = finite(band.lo, defaults?.lo ?? 0);
  const rawHi = Number(band.hi ?? defaults?.hi);
  const hi = rawHi === Number.POSITIVE_INFINITY ? rawHi : finite(rawHi, lo);
  const orderedHi = Math.max(lo, hi);
  const width = Number.isFinite(orderedHi) ? Math.max(orderedHi - lo, 1) : Math.max(Math.abs(lo), 1);
  const configuredSlope = band.slope ?? prefs?.slopes?.[metric] ?? defaults?.slope;
  const slope = Math.max(0, finite(configuredSlope, 1 / width));
  const weight = Math.max(0, finite(
    band.weight ?? prefs?.weights?.[metric] ?? defaults?.weight,
    defaults?.weight ?? 1,
  ));
  return { lo, hi: orderedHi, slope, weight };
}

function metricValue(observed, metric) {
  if (EXEMPT_METRICS.has(metric)) {
    const raw = observed?.[metric];
    // 禁止 Number(null)→0：无观测是豁免，不是「满分锚点 / 相对最响 0dB」。
    if (raw == null) return null;
    return Number.isFinite(Number(raw)) ? Number(raw) : null;
  }
  return Math.max(0, finite(observed?.[metric], 0));
}

/** 缺失观测（null）不进分：权重归零后由调用方重归一。 */
function isExempt(metric, value) {
  return EXEMPT_METRICS.has(metric) && value == null;
}

function directionAndDistance(value, band) {
  if (value < band.lo) return { direction: 'low', amount: band.lo - value };
  if (value > band.hi) return { direction: 'high', amount: value - band.hi };
  return { direction: 'within', amount: 0 };
}

/**
 * 相对当日最响声部的电平（dB）。无有效锚（无采样/全静音）→ null。
 * @param {number} rms
 * @param {number} anchorRms 当日最响声部 RMS
 */
export function relativeLevelDb(rms, anchorRms) {
  if (!(Number(anchorRms) > 0)) return null;
  if (!(Number(rms) > 0)) return SILENCE_FLOOR_DB;
  return 20 * Math.log10(Number(rms) / Number(anchorRms));
}

/**
 * 从 getAudioLevels 快照提取一声部的 loudnessBalance（相对最响 dB）。
 * 全日无采样或全静音 → null（豁免，非 0 分）。
 */
export function loudnessBalanceFromLevels(levels, species) {
  if (!levels || typeof levels !== 'object') return null;
  const entries = Object.values(levels);
  const totalSamples = entries.reduce((sum, entry) => sum + Math.max(0, finite(entry?.samples, 0)), 0);
  if (totalSamples <= 0) return null;
  const maxRms = Math.max(0, ...entries.map((entry) => Math.max(0, finite(entry?.rms, 0))));
  if (!(maxRms > 0)) return null;
  const mine = levels[species];
  if (!mine || typeof mine !== 'object') return null;
  return relativeLevelDb(mine.rms, maxRms);
}

/**
 * 削波告警位：peak 超过阈（默认 0.9）为 true。只观测/显示，默认不进分。
 */
export function clipWarnFromLevels(levels, species, peakThreshold = 0.9) {
  const peak = finite(levels?.[species]?.peak, 0);
  return peak > finite(peakThreshold, 0.9);
}

/** 带内为 1；带外按 boundary 距离 × slope 线性衰减并夹到 [0, 1]。loudnessBalance/crossVoice=null 豁免。 */
export function scoreDay(observed = {}, prefs = DEFAULT_PREFS.pad) {
  let weightedScore = 0;
  let totalWeight = 0;
  for (const metric of METRICS) {
    const value = metricValue(observed, metric);
    if (isExempt(metric, value)) continue;
    const band = bandFor(prefs, metric);
    const { amount } = directionAndDistance(value, band);
    const score = Math.max(0, 1 - amount * band.slope);
    weightedScore += score * band.weight;
    totalWeight += band.weight;
  }
  return totalWeight > 0 ? weightedScore / totalWeight : 0;
}

/**
 * 显示用的可溯源分解；与 scoreDay 使用同一 bandFor/线性衰减口径。
 * loudnessBalance/crossVoice 缺失时 direction='exempt'、score=null，不计入 total。
 */
export function scoreBreakdown(observed = {}, prefs = DEFAULT_PREFS.pad) {
  const metrics = {};
  let weightedScore = 0;
  let totalWeight = 0;
  for (const metric of METRICS) {
    const value = metricValue(observed, metric);
    const band = bandFor(prefs, metric);
    if (isExempt(metric, value)) {
      metrics[metric] = {
        value: null, ...band, direction: 'exempt', amount: 0, score: null, weight: 0,
      };
      continue;
    }
    const deviation = directionAndDistance(value, band);
    const score = Math.max(0, 1 - deviation.amount * band.slope);
    metrics[metric] = { value, ...band, ...deviation, score };
    weightedScore += score * band.weight;
    totalWeight += band.weight;
  }
  return {
    metrics,
    total: totalWeight > 0 ? weightedScore / totalWeight : 0,
  };
}

/**
 * 返回方向字段（low/within/high/exempt）及同单位的绝对偏离量。
 * `magnitude` 便于日志直接拼成“换枝低 3 次”，`details` 保留数值和偏好带。
 */
export function deviationReport(observed = {}, prefs = DEFAULT_PREFS.pad) {
  const report = { magnitude: {}, details: {} };
  for (const metric of METRICS) {
    const value = metricValue(observed, metric);
    const band = bandFor(prefs, metric);
    if (isExempt(metric, value)) {
      report[metric] = 'exempt';
      report.magnitude[metric] = 0;
      report.details[metric] = { value: null, lo: band.lo, hi: band.hi, direction: 'exempt', amount: 0 };
      continue;
    }
    const deviation = directionAndDistance(value, band);
    report[metric] = deviation.direction;
    report.magnitude[metric] = deviation.amount;
    report.details[metric] = { value, lo: band.lo, hi: band.hi, ...deviation };
  }
  return report;
}

function eventType(event) {
  return event?.event ?? event?.type ?? null;
}

function countsAsDwellSample(cause) {
  // 与 world.launch 一致：只记日内 hop / 用户摆位；settle·manual 归巢长窝不计。
  return cause === 'hop' || cause === 'user' || cause === 'sequence' || cause == null;
}

export function intervalRegularityFromSteps(steps = [], stepCount = 16) {
  const count = Math.max(1, Math.trunc(finite(stepCount, 16)));
  const ordered = [...new Set((steps ?? [])
    .map((step) => Math.trunc(Number(step)))
    .filter((step) => step >= 0 && step < count))].sort((a, b) => a - b);
  if (ordered.length < 2) return 0;
  const gaps = ordered.map((step, index) => {
    const next = ordered[(index + 1) % ordered.length];
    return (next - step + count) % count || count;
  });
  const avg = count / ordered.length;
  const variance = gaps.reduce((sum, gap) => sum + (gap - avg) ** 2, 0) / gaps.length;
  const coefficient = Math.sqrt(variance) / Math.max(avg, 1e-9);
  return Math.max(0, Math.min(1, 1 / (1 + coefficient)));
}

function quantile(values, q = 0.9) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * q) - 1)];
}

/**
 * 创建一个确定性的逐日观察器。
 * 群聚习性分使用同枝负载的时间加权 P90，避免短促尖峰定义全天；
 * 瞬时峰值仍以 cohortPeak 独立返回，供安全告警与诊断。
 * @param {object} prefs 偏好带
 * @param {{ beatsPerDay?: number }} [options] 日长拍数（无离枝稳栖日的开放样本默认值）
 */
export function createDayObserver(prefs = DEFAULT_PREFS.pad, options = {}) {
  const beatsPerDay = Math.max(1, finite(options.beatsPerDay, DEFAULT_BEATS_PER_DAY));
  const stepCount = Math.max(1, Math.trunc(finite(options.stepCount, DEFAULT_BEATS_PER_DAY)));
  const birdBranches = new Map();
  const lastBranches = new Map();
  const branchLoads = new Map();
  let branchChanges = 0;
  let dwellTotal = 0;
  let dwellSamples = 0;
  let cohortPeak = 0;
  let cohortStartLoad = 0;
  const cohortSamples = [];
  const cohortChanges = [];
  const onsetSteps = new Set();
  const onsetCells = new Map();

  const currentCohort = () => branchLoads.size ? Math.max(0, ...branchLoads.values()) : 0;

  function updatePeak(event) {
    const eventLoad = finite(event?.perchedOnBranch, -1);
    if (eventLoad >= 0) cohortPeak = Math.max(cohortPeak, eventLoad);
    for (const load of branchLoads.values()) cohortPeak = Math.max(cohortPeak, load);
    const load = Math.max(currentCohort(), eventLoad >= 0 ? eventLoad : 0);
    cohortSamples.push(load);
    const time = Number(event?.time);
    if (Number.isFinite(time)) cohortChanges.push({ time, load });
  }

  function cohortP90({ dayStart, endTime } = {}) {
    const start = Number(dayStart);
    const end = Number(endTime);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      const durations = new Map();
      let cursor = start;
      let load = cohortStartLoad;
      for (const change of cohortChanges) {
        if (change.time <= start) {
          load = change.load;
          continue;
        }
        if (change.time >= end) break;
        durations.set(load, (durations.get(load) ?? 0) + Math.max(0, change.time - cursor));
        cursor = change.time;
        load = change.load;
      }
      durations.set(load, (durations.get(load) ?? 0) + Math.max(0, end - cursor));
      const total = [...durations.values()].reduce((sum, duration) => sum + duration, 0);
      if (total > 0) {
        let accumulated = 0;
        for (const [value, duration] of [...durations.entries()].sort((a, b) => a[0] - b[0])) {
          accumulated += duration;
          if (accumulated >= total * 0.9) return value;
        }
      }
    }
    return quantile(cohortSamples.length ? cohortSamples : [currentCohort()]);
  }

  function addDwellSample(dwell) {
    if (Number.isFinite(dwell) && dwell > 0) {
      dwellTotal += dwell;
      dwellSamples += 1;
    }
  }

  function feedOne(event) {
    if (!event || typeof event !== 'object') return;
    const type = eventType(event);
    const birdId = event.birdId;
    const branchId = event.branchId;
    if (type === 'perch' && birdId != null && branchId != null) {
      if (Number.isInteger(event.stepIndex) && event.stepIndex >= 0 && event.stepIndex < stepCount) {
        onsetSteps.add(event.stepIndex);
        const role = Number.isInteger(event.pitchBranchId) ? event.pitchBranchId : branchId;
        onsetCells.set(`${role}:${event.stepIndex}`, { pitchBranchId: role, stepIndex: event.stepIndex });
      }
      const previous = lastBranches.get(birdId);
      // world 明确以 cause=hop 表示日内换枝；对不带 cause 的构造/外部事件，
      // 退化为同一只鸟前后落在不同枝的推断。
      if (event.cause === 'hop' || event.cause === 'user'
        || (event.cause === 'sequence' && previous != null && previous !== branchId)
        || (event.cause == null && previous != null && previous !== branchId)) {
        branchChanges += 1;
      }
      const occupied = birdBranches.get(birdId);
      if (occupied != null && occupied !== branchId) {
        branchLoads.set(occupied, Math.max(0, (branchLoads.get(occupied) ?? 1) - 1));
      }
      if (occupied !== branchId) branchLoads.set(branchId, (branchLoads.get(branchId) ?? 0) + 1);
      birdBranches.set(birdId, branchId);
      lastBranches.set(birdId, branchId);
      updatePeak(event);
    } else if (type === 'unperch') {
      // world 新事件提供 dwellBeats；旧/外部事件仅有 dwellTime 时保留兼容兜底。
      const dwell = Number(event.dwellBeats ?? event.dwellTime);
      // 与 world 日终统计一致：零时长 / 非 hop|user 不算驻留样本。
      if (countsAsDwellSample(event.cause)) addDwellSample(dwell);
      const occupied = birdBranches.get(birdId);
      const leaving = occupied ?? branchId;
      if (birdId != null && leaving != null) lastBranches.set(birdId, leaving);
      if (occupied != null) {
        branchLoads.set(occupied, Math.max(0, (branchLoads.get(occupied) ?? 1) - 1));
        birdBranches.delete(birdId);
      }
      updatePeak(event);
    }
  }

  function feed(eventOrEvents) {
    if (Array.isArray(eventOrEvents)) {
      for (const event of eventOrEvents) feedOne(event);
    } else feedOne(eventOrEvents);
    return api;
  }

  function snapshot(range = {}) {
    return Object.freeze({
      branchChanges,
      onsetCount: onsetSteps.size,
      intervalRegularity: intervalRegularityFromSteps([...onsetSteps], stepCount),
      roleDiversity: jungleRoleDiversity([...onsetCells.values()]),
      meanDwell: dwellSamples > 0 ? dwellTotal / dwellSamples : 0,
      cohortSize: cohortP90(range),
      cohortPeak,
      dwellSamples,
    });
  }

  function reset({ keepOccupancy = true } = {}) {
    branchChanges = 0;
    dwellTotal = 0;
    dwellSamples = 0;
    onsetSteps.clear();
    onsetCells.clear();
    cohortSamples.length = 0;
    cohortChanges.length = 0;
    if (keepOccupancy) {
      cohortStartLoad = currentCohort();
      cohortPeak = cohortStartLoad;
    } else {
      cohortPeak = 0;
      cohortStartLoad = 0;
      birdBranches.clear();
      lastBranches.clear();
      branchLoads.clear();
    }
    return api;
  }

  /**
   * 日终关账。可选 openDwellBeats：与 world 日终仍栖样本对齐的开放驻留（拍）。
   * 若未提供且当日无离枝样本、但仍有栖鸟 → 按全天连续栖枝记 beatsPerDay（P0-1）。
   */
  function finishDay({ openDwellBeats, dayStart, endTime } = {}) {
    if (Array.isArray(openDwellBeats)) {
      for (const dwell of openDwellBeats) addDwellSample(dwell);
    } else if (dwellSamples === 0 && birdBranches.size > 0) {
      // P0-1：稳栖日无 unperch → 全天连续栖枝 ≈ 日长拍数（每只仍栖鸟一份）
      for (let i = 0; i < birdBranches.size; i += 1) addDwellSample(beatsPerDay);
    }
    const day = snapshot({ dayStart, endTime });
    reset();
    return day;
  }

  const api = Object.freeze({
    feed,
    observe: feed,
    snapshot,
    finishDay,
    settleDay: finishDay,
    endDay: finishDay,
    reset,
    score: () => scoreDay(snapshot(), prefs),
    report: () => deviationReport(snapshot(), prefs),
  });
  return api;
}

/**
 * 跨声部生态位观察者（conductor/master 级，看全部四树）。
 * Sequence v2 口径：perch 是起音，只占一个可配 gate；unperch 仅保留兼容。
 * 3–4 轨可以同时发音；只有高密度且最近音区距离过小才记冲突。
 * 可选事件字段 midi（由接线层注解）用于音区互补；缺省则 register 分量豁免、总分=时间分。
 *
 * @param {{ treeIds?: string[], bpm?: number, binBeats?: number,
 *           timeWeight?: number, registerWeight?: number }} [options]
 */
export function createCrossVoiceObserver(options = {}) {
  const treeIds = [...(options.treeIds ?? ['pad', 'melody', 'bass', 'texture'])];
  const binBeats = Math.max(1e-6, finite(options.binBeats, 0.5));
  const timeWeight = Math.max(0, finite(options.timeWeight, DEFAULT_CROSS_VOICE_BLEND.timeWeight));
  const registerWeight = Math.max(0, finite(options.registerWeight, DEFAULT_CROSS_VOICE_BLEND.registerWeight));
  const conflictThreshold = Math.max(0, Math.min(1, finite(options.conflictThreshold, 0.5)));
  const blankThreshold = Math.max(0, Math.min(1, finite(options.blankThreshold, 0.25)));
  const suppressCount = Math.max(1, Math.min(treeIds.length, Math.round(finite(options.suppressCount, 1))));
  const stickyShareMin = Math.max(0, Math.min(1, finite(options.stickyShareMin, 0.8)));
  const gateBeats = Math.max(1e-6, finite(options.gateBeats, binBeats));
  const denseVoiceThreshold = Math.max(2, Math.min(treeIds.length,
    Math.round(finite(options.denseVoiceThreshold, 3))));
  const closeRegisterSemitones = Math.max(0, finite(options.closeRegisterSemitones, 5));
  let bpm = Math.max(1, finite(options.bpm, 60));
  const events = [];
  let perchCount = 0;
  // 跨日保留上次被减弱者；冲突连续时换一树，避免固定声部被压。
  let lastSuppressedId = null;

  function feedOne(event) {
    if (!event || typeof event !== 'object') return;
    const type = eventType(event);
    if (type !== 'perch' && type !== 'unperch') return;
    const treeId = event.treeId;
    if (treeId == null || !treeIds.includes(treeId)) return;
    const time = finite(event.time, NaN);
    if (!Number.isFinite(time)) return;
    const midi = Number(event.midi);
    events.push({
      type,
      treeId,
      time,
      midi: Number.isFinite(midi) ? midi : null,
    });
    if (type === 'perch') perchCount += 1;
  }

  function feed(eventOrEvents) {
    if (Array.isArray(eventOrEvents)) {
      for (const event of eventOrEvents) feedOne(event);
    } else feedOne(eventOrEvents);
    return api;
  }

  function registerSeparation(midis) {
    if (midis.length < 2) return null;
    let minDist = Infinity;
    for (let i = 0; i < midis.length; i += 1) {
      for (let j = i + 1; j < midis.length; j += 1) {
        minDist = Math.min(minDist, Math.abs(midis[i] - midis[j]));
      }
    }
    // 理想错峰 ≥ 一倍频程；夹到 [0,1]
    return Math.max(0, Math.min(1, minDist / 12));
  }

  function analyze({ dayStart = 0, dayLength } = {}) {
    const binSeconds = (60 / bpm) * binBeats;
    const t0 = Number.isFinite(Number(dayStart)) ? Number(dayStart) : 0;
    // 日窗必须用「当日时长」，禁止用绝对 simTime 当 duration——否则 day2+ 前段空 bin
    // 会被算成 blank，blankRatio 虚高，执行器误走「过空→鼓励」把 hoppers 加码。
    const fallbackSpan = events.length
      ? Math.max(...events.map((e) => e.time)) - t0
      : binSeconds;
    const duration = Math.max(binSeconds, finite(dayLength, fallbackSpan));
    const bins = Math.max(1, Math.ceil(duration / binSeconds));
    const occupancy = Object.fromEntries(treeIds.map((id) => [id, 0]));
    const conflictOccupancy = Object.fromEntries(treeIds.map((id) => [id, 0]));
    const treeQualitySum = Object.fromEntries(treeIds.map((id) => [id, 0]));
    const treeQualitySamples = Object.fromEntries(treeIds.map((id) => [id, 0]));
    // 事件时间折到日窗 [0, duration)；窗外事件忽略（防御绝对时间混入）。
    const ordered = events
      .map((event) => ({ ...event, time: event.time - t0 }))
      .filter((event) => event.time >= -1e-9 && event.time < duration + 1e-9)
      .sort((a, b) => a.time - b.time);
    const onsets = ordered.filter((event) => event.type === 'perch');
    const gateSeconds = (60 / bpm) * gateBeats;
    let conflict = 0;
    let blank = 0;
    let complementary = 0;
    let registerSum = 0;
    let registerSamples = 0;

    for (let i = 0; i < bins; i += 1) {
      const from = i * binSeconds;
      const until = (i + 1) * binSeconds;
      const gated = onsets.filter((event) => event.time < until && event.time + gateSeconds > from);
      const activeIds = treeIds.filter((id) => gated.some((event) => event.treeId === id));
      for (const id of activeIds) occupancy[id] += 1;
      const active = activeIds.length;
      // 同一轨的复音先折成该轨的音区中心，不把轨内音程误当跨轨冲突。
      const midis = activeIds.map((id) => {
        const values = gated.filter((event) => event.treeId === id && event.midi != null)
          .map((event) => event.midi);
        return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      }).filter((midi) => midi != null);
      const sep = active >= 2 ? registerSeparation(midis) : null;
      const minDistance = sep == null ? null : sep * 12;
      // midi 缺失时仅四轨全齐才保守判冲突，避免把普通三声部编配压成两轨。
      const isConflict = active >= denseVoiceThreshold
        && (minDistance == null ? active === treeIds.length : minDistance < closeRegisterSemitones);
      if (active === 0) blank += 1;
      else if (isConflict) conflict += 1;
      else complementary += 1;

      if (sep != null) {
        registerSum += sep;
        registerSamples += 1;
      }
      for (const id of activeIds) {
        if (isConflict) conflictOccupancy[id] += 1;
        const rw = sep == null ? 0 : registerWeight;
        const denom = timeWeight + rw;
        const quality = denom > 0
          ? (timeWeight * (isConflict ? 0 : 1) + rw * (sep ?? 0)) / denom
          : (isConflict ? 0 : 1);
        treeQualitySum[id] += quality;
        treeQualitySamples[id] += 1;
      }
    }

    const timeOffsetScore = complementary / bins;
    const registerScore = registerSamples > 0 ? registerSum / registerSamples : null;
    const tw = timeWeight;
    const rw = registerScore == null ? 0 : registerWeight;
    const denom = tw + rw;
    const crossVoice = denom > 0
      ? ((tw * timeOffsetScore) + (rw * (registerScore ?? 0))) / denom
      : timeOffsetScore;
    const occupancyShare = Object.fromEntries(
      treeIds.map((id) => [id, occupancy[id] / bins]),
    );
    const conflictShare = Object.fromEntries(
      treeIds.map((id) => [id, conflictOccupancy[id] / bins]),
    );
    const treeScores = Object.fromEntries(treeIds.map((id) => [id,
      treeQualitySamples[id] > 0 ? treeQualitySum[id] / treeQualitySamples[id] : null,
    ]));
    return {
      timeOffsetScore,
      registerScore,
      crossVoice,
      conflictRatio: conflict / bins,
      blankRatio: blank / bins,
      occupancyShare,
      conflictShare,
      treeScores,
      bins,
      perchCount,
    };
  }

  /**
   * 按占用份额给出每树偏置提示（强度由 config.economy.crossVoice 注入的阈值/棵数控制）。
   * 过挤：suppress 高占用粘性声部；冲突期绝不 encourage。
   * 过空：encourage 低占用。甜蜜点：全部 hold。
   */
  function biasHintsFrom(day) {
    const shares = treeIds
      .map((id) => ({ id, share: day.occupancyShare[id] ?? 0, conflict: day.conflictShare[id] ?? 0 }))
      .sort((a, b) => b.conflict - a.conflict || b.share - a.share);
    const hints = Object.fromEntries(treeIds.map((id) => [id, 'hold']));
    if (day.perchCount <= 0) return hints;
    if (day.conflictRatio >= conflictThreshold) {
      const sticky = shares.filter((entry) => entry.share >= stickyShareMin);
      const pool = sticky.length >= suppressCount ? sticky : shares;
      // suppressCount 现为 1；仍保留通用 slice，并优先避开上日已被压的树。
      const lastIndex = pool.findIndex((entry) => entry.id === lastSuppressedId);
      const start = lastIndex >= 0 ? (lastIndex + 1) % pool.length : 0;
      const rotated = [...pool.slice(start), ...pool.slice(0, start)];
      const selected = rotated.slice(0, suppressCount);
      for (const entry of selected) hints[entry.id] = 'suppress';
      lastSuppressedId = selected.at(-1)?.id ?? lastSuppressedId;
    } else if (day.blankRatio >= blankThreshold) {
      for (const entry of [...shares].reverse().slice(0, 2)) {
        if (entry.share < 0.55) hints[entry.id] = 'encourage';
      }
    }
    return hints;
  }

  function finishDay({ endTime, dayStart, dayLength, bpm: nextBpm } = {}) {
    if (Number.isFinite(Number(nextBpm)) && Number(nextBpm) > 0) bpm = Number(nextBpm);
    // 无发声窗口 → null 豁免（与 loudnessBalance 同口径）
    if (perchCount <= 0) {
      events.length = 0;
      perchCount = 0;
      return Object.freeze({
        timeOffsetScore: null,
        registerScore: null,
        crossVoice: null,
        conflictRatio: 0,
        blankRatio: 1,
        occupancyShare: Object.fromEntries(treeIds.map((id) => [id, 0])),
        conflictShare: Object.fromEntries(treeIds.map((id) => [id, 0])),
        treeScores: Object.fromEntries(treeIds.map((id) => [id, null])),
        biasHints: Object.fromEntries(treeIds.map((id) => [id, 'hold'])),
        perchCount: 0,
      });
    }
    const t0 = Number.isFinite(Number(dayStart))
      ? Number(dayStart)
      : (Number.isFinite(Number(endTime)) && Number.isFinite(Number(dayLength))
        ? Number(endTime) - Number(dayLength)
        : (events.length ? Math.min(...events.map((e) => e.time)) : 0));
    const length = Number.isFinite(Number(dayLength))
      ? Number(dayLength)
      : (Number.isFinite(Number(endTime)) ? Number(endTime) - t0 : undefined);
    const day = analyze({ dayStart: t0, dayLength: length });
    const biasHints = biasHintsFrom(day);
    events.length = 0;
    perchCount = 0;
    return Object.freeze({ ...day, biasHints });
  }

  function reset() {
    events.length = 0;
    perchCount = 0;
    lastSuppressedId = null;
    return api;
  }

  const api = Object.freeze({ feed, observe: feed, finishDay, reset });
  return api;
}
