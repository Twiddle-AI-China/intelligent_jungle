// Phase 1.7 生态计分核心。
// 接线：订阅 world 的 `*` 事件并逐条 observer.feed(event)，黎明/日终调用
// observer.finishDay() 取得刚结束一天的观测；黄昏复盘把 scoreDay 与
// deviationReport 一起注入 agent。模块不读取 config，也不发明任何资源状态。
//
// 驻留口径（与 world.finalizeDayStats 统一，T40）：
// meanDwell（拍）= 当日驻留样本的算术平均。
// 样本 = 日内离枝且 dwell>0（cause=hop|user；settle/归巢不计）
//      + 日终仍栖的开放样本（由 finishDay({ openDwellBeats }) 注入，或无离枝且仍有栖鸟时
//        按「全天连续栖枝」≈ beatsPerDay 记——杜绝「不动=0拍=0分」激励倒挂）。
//
// 响度失衡（第四维 loudnessBalance，R1）：
// 值 = 相对当日最响声部的电平 dB（20·log10(rms/maxRms)）。
// 无电平数据 → null 豁免（权重归零重归一；不得当 0 分——同 H null 透传教训）。

const BEHAVIOR_METRICS = Object.freeze(['branchChanges', 'meanDwell', 'cohortSize']);
const METRICS = Object.freeze([...BEHAVIOR_METRICS, 'loudnessBalance']);
const DEFAULT_BEATS_PER_DAY = 16; // tempo.barsPerDay × beatsPerBar（1 循环）
// 响度默认带：锚=当日最响 RMS；过静 <-24dB、过响 >-3dB（kimi2 / r2-retest §5）。
const DEFAULT_LOUDNESS_BAND = Object.freeze({ lo: -24, hi: -3, slope: 1 / 12, weight: 0.5 });
const SILENCE_FLOOR_DB = -120;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function withLoudness(prefs) {
  return {
    ...prefs,
    loudnessBalance: { ...DEFAULT_LOUDNESS_BAND, ...(prefs.loudnessBalance ?? {}) },
    weights: { ...prefs.weights, loudnessBalance: prefs.weights?.loudnessBalance ?? DEFAULT_LOUDNESS_BAND.weight },
  };
}

// §2 四树 profile，单位统一为每循环换枝次数与驻留拍数。开放上界用
// hi=Infinity 表示：过长不扣分，只惩罚低于下沿。
export const DEFAULT_PREFS = deepFreeze({
  melody: withLoudness({
    branchChanges: { lo: 8, hi: 16, slope: 1 / 8 },
    meanDwell: { lo: 0.5, hi: 2, slope: 2 / 3 },
    cohortSize: { lo: 1, hi: 1, slope: 1 },
    weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1 },
  }),
  pad: withLoudness({
    branchChanges: { lo: 0, hi: 1, slope: 1 / 2 },
    meanDwell: { lo: 8, hi: Number.POSITIVE_INFINITY, slope: 1 / 8 },
    cohortSize: { lo: 1, hi: 2, slope: 1 },
    weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1 },
  }),
  bass: withLoudness({
    branchChanges: { lo: 0, hi: 0, slope: 1 },
    meanDwell: { lo: 16, hi: Number.POSITIVE_INFINITY, slope: 1 / 16 },
    cohortSize: { lo: 1, hi: 2, slope: 1 },
    weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1 },
  }),
  texture: withLoudness({
    branchChanges: { lo: 4, hi: 8, slope: 1 / 4 },
    meanDwell: { lo: 1, hi: 4, slope: 1 / 3 },
    cohortSize: { lo: 1, hi: 1, slope: 1 },
    weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1 },
  }),
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function bandFor(prefs, metric) {
  const band = prefs?.[metric] ?? {};
  const defaults = metric === 'loudnessBalance' ? DEFAULT_LOUDNESS_BAND : null;
  const lo = finite(band.lo, defaults?.lo ?? 0);
  const rawHi = Number(band.hi ?? defaults?.hi);
  const hi = rawHi === Number.POSITIVE_INFINITY ? rawHi : finite(rawHi, lo);
  const orderedHi = Math.max(lo, hi);
  const width = Number.isFinite(orderedHi) ? Math.max(orderedHi - lo, 1) : Math.max(Math.abs(lo), 1);
  const configuredSlope = band.slope ?? prefs?.slopes?.[metric] ?? defaults?.slope;
  const slope = Math.max(0, finite(configuredSlope, 1 / width));
  const weight = Math.max(0, finite(
    band.weight ?? prefs?.weights?.[metric] ?? defaults?.weight,
    metric === 'loudnessBalance' ? DEFAULT_LOUDNESS_BAND.weight : 1,
  ));
  return { lo, hi: orderedHi, slope, weight };
}

function metricValue(observed, metric) {
  if (metric === 'loudnessBalance') {
    const raw = observed?.[metric];
    // 禁止 Number(null)→0：无电平是豁免，不是「相对最响 0dB」。
    if (raw == null) return null;
    return Number.isFinite(Number(raw)) ? Number(raw) : null;
  }
  return Math.max(0, finite(observed?.[metric], 0));
}

/** 缺失观测（null）不进分：权重归零后由调用方重归一。 */
function isExempt(metric, value) {
  return metric === 'loudnessBalance' && value == null;
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

/** 带内为 1；带外按 boundary 距离 × slope 线性衰减并夹到 [0, 1]。loudnessBalance=null 豁免。 */
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
 * loudnessBalance 缺失时 direction='exempt'、score=null，不计入 total。
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
  return cause === 'hop' || cause === 'user' || cause == null;
}

/**
 * 创建一个确定性的逐日观察器。
 * 群聚选择“同枝日内峰值”而非均值：world 的 perch 事件天然携带瞬时负载，
 * 峰值既不依赖采样频率，又能如实捕捉短暂但影响听感的扎堆。
 * @param {object} prefs 偏好带
 * @param {{ beatsPerDay?: number }} [options] 日长拍数（无离枝稳栖日的开放样本默认值）
 */
export function createDayObserver(prefs = DEFAULT_PREFS.pad, options = {}) {
  const beatsPerDay = Math.max(1, finite(options.beatsPerDay, DEFAULT_BEATS_PER_DAY));
  const birdBranches = new Map();
  const lastBranches = new Map();
  const branchLoads = new Map();
  let branchChanges = 0;
  let dwellTotal = 0;
  let dwellSamples = 0;
  let cohortPeak = 0;

  function updatePeak(event) {
    const eventLoad = finite(event?.perchedOnBranch, -1);
    if (eventLoad >= 0) cohortPeak = Math.max(cohortPeak, eventLoad);
    for (const load of branchLoads.values()) cohortPeak = Math.max(cohortPeak, load);
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
      const previous = lastBranches.get(birdId);
      // world 明确以 cause=hop 表示日内换枝；对不带 cause 的构造/外部事件，
      // 退化为同一只鸟前后落在不同枝的推断。
      if (event.cause === 'hop' || event.cause === 'user'
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
    }
  }

  function feed(eventOrEvents) {
    if (Array.isArray(eventOrEvents)) {
      for (const event of eventOrEvents) feedOne(event);
    } else feedOne(eventOrEvents);
    return api;
  }

  function snapshot() {
    return Object.freeze({
      branchChanges,
      meanDwell: dwellSamples > 0 ? dwellTotal / dwellSamples : 0,
      cohortSize: cohortPeak,
      dwellSamples,
    });
  }

  function reset({ keepOccupancy = true } = {}) {
    branchChanges = 0;
    dwellTotal = 0;
    dwellSamples = 0;
    if (keepOccupancy) {
      cohortPeak = branchLoads.size ? Math.max(0, ...branchLoads.values()) : 0;
    } else {
      cohortPeak = 0;
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
  function finishDay({ openDwellBeats } = {}) {
    if (Array.isArray(openDwellBeats)) {
      for (const dwell of openDwellBeats) addDwellSample(dwell);
    } else if (dwellSamples === 0 && birdBranches.size > 0) {
      // P0-1：稳栖日无 unperch → 全天连续栖枝 ≈ 日长拍数（每只仍栖鸟一份）
      for (let i = 0; i < birdBranches.size; i += 1) addDwellSample(beatsPerDay);
    }
    const day = snapshot();
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
