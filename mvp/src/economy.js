// Phase 1.7 生态计分核心。
// 接线：订阅 world 的 `*` 事件并逐条 observer.feed(event)，黎明/日终调用
// observer.finishDay() 取得刚结束一天的三项观测；黄昏复盘把 scoreDay 与
// deviationReport 一起注入 agent。模块不读取 config，也不发明任何资源状态。

const METRICS = Object.freeze(['branchChanges', 'meanDwell', 'cohortSize']);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// §2 四树 profile，单位统一为每循环换枝次数与驻留拍数。开放上界用
// hi=Infinity 表示：过长不扣分，只惩罚低于下沿。
export const DEFAULT_PREFS = deepFreeze({
  melody: {
    branchChanges: { lo: 8, hi: 16, slope: 1 / 8 },
    meanDwell: { lo: 0.5, hi: 2, slope: 2 / 3 },
    cohortSize: { lo: 1, hi: 1, slope: 1 },
    weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1 },
  },
  pad: {
    branchChanges: { lo: 0, hi: 1, slope: 1 / 2 },
    meanDwell: { lo: 8, hi: Number.POSITIVE_INFINITY, slope: 1 / 8 },
    cohortSize: { lo: 1, hi: 2, slope: 1 },
    weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1 },
  },
  bass: {
    branchChanges: { lo: 0, hi: 0, slope: 1 },
    meanDwell: { lo: 16, hi: Number.POSITIVE_INFINITY, slope: 1 / 16 },
    cohortSize: { lo: 1, hi: 2, slope: 1 },
    weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1 },
  },
  texture: {
    branchChanges: { lo: 4, hi: 8, slope: 1 / 4 },
    meanDwell: { lo: 1, hi: 4, slope: 1 / 3 },
    cohortSize: { lo: 1, hi: 1, slope: 1 },
    weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1 },
  },
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function bandFor(prefs, metric) {
  const band = prefs?.[metric] ?? {};
  const lo = finite(band.lo, 0);
  const rawHi = Number(band.hi);
  const hi = rawHi === Number.POSITIVE_INFINITY ? rawHi : finite(rawHi, lo);
  const orderedHi = Math.max(lo, hi);
  const width = Number.isFinite(orderedHi) ? Math.max(orderedHi - lo, 1) : Math.max(Math.abs(lo), 1);
  const configuredSlope = band.slope ?? prefs?.slopes?.[metric];
  const slope = Math.max(0, finite(configuredSlope, 1 / width));
  const weight = Math.max(0, finite(band.weight ?? prefs?.weights?.[metric], 1));
  return { lo, hi: orderedHi, slope, weight };
}

function metricValue(observed, metric) {
  return Math.max(0, finite(observed?.[metric], 0));
}

function directionAndDistance(value, band) {
  if (value < band.lo) return { direction: 'low', amount: band.lo - value };
  if (value > band.hi) return { direction: 'high', amount: value - band.hi };
  return { direction: 'within', amount: 0 };
}

/** 带内为 1；带外按 boundary 距离 × slope 线性衰减并夹到 [0, 1]。 */
export function scoreDay(observed = {}, prefs = DEFAULT_PREFS.pad) {
  let weightedScore = 0;
  let totalWeight = 0;
  for (const metric of METRICS) {
    const band = bandFor(prefs, metric);
    const { amount } = directionAndDistance(metricValue(observed, metric), band);
    const score = Math.max(0, 1 - amount * band.slope);
    weightedScore += score * band.weight;
    totalWeight += band.weight;
  }
  return totalWeight > 0 ? weightedScore / totalWeight : 0;
}

/**
 * 返回方向字段（low/within/high）及同单位的绝对偏离量。
 * `magnitude` 便于日志直接拼成“换枝低 3 次”，`details` 保留数值和偏好带。
 */
export function deviationReport(observed = {}, prefs = DEFAULT_PREFS.pad) {
  const report = { magnitude: {}, details: {} };
  for (const metric of METRICS) {
    const value = metricValue(observed, metric);
    const band = bandFor(prefs, metric);
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

/**
 * 创建一个确定性的逐日观察器。
 * 群聚选择“同枝日内峰值”而非均值：world 的 perch 事件天然携带瞬时负载，
 * 峰值既不依赖采样频率，又能如实捕捉短暂但影响听感的扎堆。
 */
export function createDayObserver(prefs = DEFAULT_PREFS.pad) {
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
      // 与 world 日终统计一致：零时长只是瞬时状态切换，不算驻留样本。
      if (Number.isFinite(dwell) && dwell > 0) {
        dwellTotal += dwell;
        dwellSamples += 1;
      }
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

  function finishDay() {
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
