// Master 的同步兜底策略与新菜单校验。
// 契约：季 = 四和弦日进行 × 两圈（固定 8 日）；
// 每黎明 master 只为当日选一档日间「色彩」colorId 与张力预算 tension；
// tension 必须落在菜单 tensionRange 内（旧菜单缺省为 0..1）；
// 仅在季末日额外输出 nextSeason 与 seasonLength。顺走/跳步旧菜单已废除。
// 菜单与观测量全部由集成方注入，本模块不依赖 config。
//
// Wave 2-A（docs/optimization-plan-2026-07-20.md T2.6/2.7/2.8、T4.11）：
// 平稳默认保持当前色（复活新鲜度）；季长 rng 取样；换色带生态相位偏移；
// 季末日/冷却期色彩按日轮转解冻（拆换季冻结链）。仍只点菜，不发明菜单外选项。

const DEFAULT_SEASON_LENGTH_RANGE = Object.freeze([8, 8]);
const DEFAULT_TENSION_RANGE = Object.freeze([0, 1]);

const integer = (value, fallback = 0) => Number.isInteger(Number(value)) ? Number(value) : fallback;

function paletteOptions(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.keys(value);
  return value == null ? [] : [value];
}

// 色彩档条目允许是 id 字符串或 {id, notes} 对象，统一收敛为 id 列表。
function colorIdsOf(value) {
  return paletteOptions(value)
    .map((entry) => (entry && typeof entry === 'object' ? entry.id ?? entry.colorId : entry))
    .filter((entry) => typeof entry === 'string' && entry.length > 0);
}

// 宽容读取三种菜单形态：colorsBySeason（新）、seasonPalettes（旧）、
// seasons 为对象 {season: {colors: [...]}}（config 直挂形态）。
function colorsBySeason(menu = {}) {
  const pick = (src, unwrap) => Object.fromEntries(
    Object.entries(src).map(([season, value]) => [season, colorIdsOf(unwrap(value))]),
  );
  if (menu.colorsBySeason && typeof menu.colorsBySeason === 'object') {
    return pick(menu.colorsBySeason, (v) => v?.colors ?? v);
  }
  if (menu.seasonPalettes && typeof menu.seasonPalettes === 'object') {
    return pick(menu.seasonPalettes, (v) => v);
  }
  if (menu.seasons && !Array.isArray(menu.seasons) && typeof menu.seasons === 'object') {
    return pick(menu.seasons, (v) => v?.colors ?? []);
  }
  return {};
}

function seasonsOf(menu = {}) {
  if (Array.isArray(menu.seasons) && menu.seasons.length) return menu.seasons.map(String);
  return Object.keys(colorsBySeason(menu));
}

function colorsOf(menu, season) {
  const bySeason = colorsBySeason(menu)[season];
  if (Array.isArray(bySeason) && bySeason.length) return bySeason;
  // 也接受直接给当季平铺色彩菜单（menu.colors）。
  return colorIdsOf(menu.colors);
}

function seasonRange(menu = {}) {
  const range = Array.isArray(menu.seasonLengthRange) ? menu.seasonLengthRange : [];
  const lo = Math.max(1, integer(range[0], DEFAULT_SEASON_LENGTH_RANGE[0]));
  return [lo, Math.max(lo, integer(range[1], DEFAULT_SEASON_LENGTH_RANGE[1]))];
}

export function tensionRange(menu = {}) {
  const range = Array.isArray(menu.tensionRange) ? menu.tensionRange : [];
  const first = Number(range[0]);
  const second = Number(range[1]);
  const lo = Number.isFinite(first) ? Math.min(1, Math.max(0, first)) : DEFAULT_TENSION_RANGE[0];
  const hi = Number.isFinite(second) ? Math.min(1, Math.max(0, second)) : DEFAULT_TENSION_RANGE[1];
  return lo <= hi ? [lo, hi] : [hi, lo];
}

/** T2.7：季长在 [lo, hi] 内 rng 取一次整数（含端点）。 */
function pickSeasonLength(lo, hi, rng = Math.random) {
  const span = Math.max(1, hi - lo + 1);
  const roll = typeof rng === 'function' ? Number(rng()) : Math.random();
  const u = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : Math.random();
  return lo + Math.min(span - 1, Math.floor(u * span));
}

/**
 * T2.8：用已有 treeScores 当日最低分树索引作换色相位（不新开观测通道）。
 * 无有效分数时回落 0 → 行为等同旧「顺挂下一档」。
 */
function ecoPhaseOffset(observations = {}) {
  const list = observations.treeScores;
  if (!Array.isArray(list) || !list.length) return 0;
  let bestIdx = 0;
  let bestVal = Infinity;
  let found = false;
  list.forEach((entry, index) => {
    const hist = (Array.isArray(entry) ? entry : [entry])
      .filter((value) => value != null)
      .map(Number)
      .filter(Number.isFinite);
    if (!hist.length) return;
    const today = hist[hist.length - 1];
    if (today < bestVal) {
      bestVal = today;
      bestIdx = index;
      found = true;
    }
  });
  return found ? bestIdx : 0;
}

// 归一化后的菜单形态，供 normalizeMasterInput / 校验共用。
export function canonMasterMenu(menu = {}) {
  return {
    seasons: seasonsOf(menu),
    colorsBySeason: colorsBySeason(menu),
    seasonLengthRange: seasonRange(menu),
    tensionRange: tensionRange(menu),
  };
}

function stateSeason(state = {}) {
  return typeof state.season === 'string' ? state.season
    : typeof state.currentSeason === 'string' ? state.currentSeason : null;
}

function stateSeasonDay(state = {}) {
  return Math.max(0, integer(state.seasonDay ?? state.daysInSeason, 0));
}

function stateSeasonLength(state, menu) {
  const explicit = integer(state?.seasonLength, 0);
  if (explicit > 0) return explicit;
  const [lo, hi] = seasonRange(menu);
  return Math.round((lo + hi) / 2);
}

function isSeasonFinalDay(state, menu) {
  return stateSeasonDay(state) >= stateSeasonLength(state, menu) - 1;
}

// 三观测量阈值（eco-incentive-design §6：均衡/新鲜/平稳）
const LOW_SCORE_FLOOR = 0.4;   // 均衡：树分低于此值记一天低分
const LOW_STREAK_DAYS = 2;     // 连续低分达到此天数才干预
const BORED_DAYS = 3;          // 新鲜（主指标）：同一色彩档连续天数达到此值才考虑换档
const SIMILARITY_BORED = 0.82; // 新鲜（辅助佐证）：pattern 相似度仍高时强化理由，不独立触发换档
const SEASON_COOLDOWN_DAYS = 2;// 平稳：换季后冷却天数（张力等维冻结；色彩按 T4.11 轮转解冻）
const decisionEvidence = new WeakMap();

// 历史读取沿用旧约定：treeScores/harmonyScores 的每个元素可为当日值或短历史数组；
// 状态记忆（连续低分天数/同档天数）全部由 state/observations 传入，不开全局变量。
function trailingLow(observations = {}) {
  let maxStreak = 0;
  let lowestToday = 1;
  let lowLabel = null;
  for (const [label, list] of [['treeScores', observations.treeScores], ['harmonyScores', observations.harmonyScores]]) {
    if (!Array.isArray(list)) continue;
    list.forEach((entry, index) => {
      // 缺失观测先剔除：Number(null) 会变成 0，既会制造虚假低分，也会污染连续观测口径。
      const hist = (Array.isArray(entry) ? entry : [entry])
        .filter((value) => value != null)
        .map(Number)
        .filter(Number.isFinite);
      if (!hist.length) return;
      const today = hist[hist.length - 1];
      let streak = 0;
      for (let i = hist.length - 1; i >= 0 && hist[i] < LOW_SCORE_FLOOR; i -= 1) streak += 1;
      if (today < lowestToday) {
        lowestToday = today;
        lowLabel = `${label}#${index}`;
      }
      if (streak > maxStreak) {
        maxStreak = streak;
        if (today < LOW_SCORE_FLOOR) lowLabel = `${label}#${index}`;
      }
    });
  }
  return { maxStreak, lowestToday, lowLabel: lowLabel ?? '树' };
}

/**
 * 只读取 decideMaster 当次真实输入派生的三观依据；WeakMap 不改决策 schema。
 * LLM/外部决策不是 policy 产物，明确返回 null，显示层不得猜测。
 */
export function getMasterDecisionEvidence(decision) {
  return decision && typeof decision === 'object' ? decisionEvidence.get(decision) ?? null : null;
}

/**
 * 纯函数 master 策略（规则兜底，eco-incentive-design §6 三观测量）：
 * - 平稳基线（T2.6）：保持 currentColorId；tension 随季节进度线性爬升；
 *   只在连续低分 / 新鲜腻值 / 季末日（及 T4.11 解冻窗）才换色。
 * - 季末日（T2.7/T4.11）：选下一季；季长 rng∈[lo,hi]；色彩按日轮转解冻。
 * - 冷却期（T4.11）：张力等维冻结意图保留，但色彩按日轮转解冻（拆换季冻结链）。
 * - 均衡：连续低分 → 换档（T2.8 生态相位偏移下家）；单日低分 → 只调 tension。
 * - 新鲜：同档 ≥ BORED_DAYS → 换档（同样带生态相位）。
 * - 一次只改一维：换档日不对 tension 做主动加调（ramp 基线照走）；动 tension 日不换档。
 */
export function decideMaster({
  menu = {}, state = {}, observations = {}, rng = Math.random,
} = {}) {
  const season = stateSeason(state);
  const colors = colorsOf(menu, season);
  const seasonDay = stateSeasonDay(state);
  const length = stateSeasonLength(state, menu);
  const ramp = Math.min(1, Math.max(0, seasonDay / Math.max(1, length - 1)));
  const [tensionLo, tensionHi] = tensionRange(menu);
  const tensionBaseline = Math.round((tensionLo + (tensionHi - tensionLo) * ramp) * 100) / 100;
  const current = typeof state.currentColorId === 'string' && colors.includes(state.currentColorId)
    ? state.currentColorId : null;
  // T4.11 解冻用：按季内日轮转（仅季末日/冷却期）；平稳默认不再用它换色。
  const rotationColor = colors.length ? colors[seasonDay % colors.length] : (current ?? 'base');
  // T2.6 平稳保持色：有 current 则守住；冷启动落菜单首档（仍是点菜）。
  const holdColor = current ?? (colors[0] ?? rotationColor);
  const phase = ecoPhaseOffset(observations);
  // T2.8：步长 = 1 + (phase % (n-1)) ∈ [1, n-1]，永不落回当前档；phase=0 等同旧顺挂。
  const nextColorOf = (from) => {
    if (colors.length < 2) return from ?? holdColor;
    const idx = colors.indexOf(from);
    const base = idx < 0 ? 0 : idx;
    const step = 1 + (phase % (colors.length - 1));
    return colors[(base + step) % colors.length];
  };
  const { maxStreak, lowestToday, lowLabel } = trailingLow(observations);
  const daysInColor = Math.max(0, integer(state.daysInColor ?? state.colorDays ?? state.sameColorDays, 0));
  const similarity = Math.min(1, Math.max(0, Number(observations.patternSimilarity) || 0));
  // 新鲜度主指标 = 同档连续天数；相似度仅辅助佐证，不独立触发（稳态世界恒 ≥0.82 会架空阈值）。
  const similarityHigh = similarity >= SIMILARITY_BORED;
  const bored = daysInColor >= BORED_DAYS ? daysInColor : 0;
  const rawDaysSinceChange = Number(state.daysSinceChange);
  const daysSinceChange = Number.isFinite(rawDaysSinceChange) && rawDaysSinceChange >= 0
    ? rawDaysSinceChange : null;
  const evidence = Object.freeze({
    balance: Object.freeze({ maxStreak, lowestToday, lowLabel, scoreFloor: LOW_SCORE_FLOOR }),
    freshness: Object.freeze({
      daysInColor,
      patternSimilarity: similarity,
      bored,
      boredDays: BORED_DAYS,
      similarityThreshold: SIMILARITY_BORED,
    }),
    stability: Object.freeze({
      daysSinceChange,
      cooldownDays: SEASON_COOLDOWN_DAYS,
      inCooldown: daysSinceChange != null && daysSinceChange < SEASON_COOLDOWN_DAYS,
    }),
  });
  const finish = (decision) => {
    decisionEvidence.set(decision, evidence);
    return decision;
  };

  if (isSeasonFinalDay(state, menu)) {
    const seasons = seasonsOf(menu);
    const [lo, hi] = seasonRange(menu);
    const next = seasons.length
      ? seasons[(seasons.indexOf(season) < 0 ? 0 : seasons.indexOf(season) + 1) % seasons.length]
      : null;
    if (next) {
      const seasonLength = pickSeasonLength(lo, hi, rng);
      return finish({
        // T4.11：季末日色彩轮转解冻（不再钉死 current）
        colorId: rotationColor,
        tension: tensionBaseline,
        nextSeason: next,
        seasonLength,
        reason: `季末日：选定菜单中的下一季，季长 rng 取样 ${seasonLength}（[${lo},${hi}]）；色彩按日轮转解冻`,
      });
    }
  }

  // T4.11：冷却期张力等维不主动干预，但色彩按日轮转解冻，拆换季冻结链。
  if (daysSinceChange != null && daysSinceChange < SEASON_COOLDOWN_DAYS) {
    return finish({
      colorId: rotationColor,
      tension: tensionBaseline,
      reason: `换季冷却期（第 ${Math.floor(daysSinceChange) + 1}/${SEASON_COOLDOWN_DAYS} 天），色彩按日轮转解冻，其他维维持 ramp 基线`,
    });
  }

  // 均衡：连续低分 → 换下一档（一次一维，tension 保持基准；T2.8 相位偏移）。
  if (maxStreak >= LOW_STREAK_DAYS && colors.length > 1) {
    const from = holdColor;
    const to = nextColorOf(from);
    return finish({
      colorId: to,
      tension: tensionBaseline,
      reason: `${lowLabel} 连续${maxStreak}日低分，换档 ${from}→${to}`
        + `（相位${phase}，一次一维，tension 不主动加调，ramp 基线照走）`,
    });
  }
  // 均衡（单日低分，未连续）：只小幅上调 tension，不换档。
  // 置于新鲜分支之前：低分日的张力微调是均衡通道职责，腻值换档不得抢跑。
  if (lowestToday < LOW_SCORE_FLOOR) {
    return finish({
      colorId: holdColor,
      tension: Math.min(tensionHi, Math.round((tensionBaseline + 0.1) * 100) / 100),
      reason: `${lowLabel} 当日低分 ${lowestToday.toFixed(2)}，张力小幅上调（一次一维，色彩档不动）`,
    });
  }
  // 新鲜：同档连续天数达腻值 → 换档（一次一维；T2.8 相位）。
  if (bored >= BORED_DAYS && colors.length > 1) {
    const from = holdColor;
    const to = nextColorOf(from);
    const why = `同一色彩档已连续${daysInColor}天`
      + (similarityHigh ? `，pattern 相似度 ${similarity.toFixed(2)} 仍高` : '');
    return finish({
      colorId: to,
      tension: tensionBaseline,
      reason: `${why}，换档 ${from}→${to} 恢复新鲜（相位${phase}）`,
    });
  }
  // T2.6：平稳 = 保持当前色（不再按日轮转），让新鲜度通道有机会触发。
  return finish({
    colorId: holdColor,
    tension: tensionBaseline,
    reason: `树况平稳：保持色彩档 ${holdColor}，张力随季节进度爬升（季内第 ${seasonDay + 1}/${length} 天）`,
  });
}

export const decideMasterPolicy = decideMaster;
export const masterPolicy = decideMaster;

/**
 * 新菜单校验：colorId 必须在当季色彩菜单内（菜单缺省时宽容放行），
 * tension 必须是菜单 tensionRange 内的有限数；nextSeason/seasonLength 仅季末日合法，
 * 且 seasonLength 必须落在 seasonLengthRange 内。非法整单返回 null（回退 policy）。
 */
export function normalizeMasterDecision(raw, menu = {}, state = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) return null;

  const colorId = typeof raw.colorId === 'string' ? raw.colorId.trim() : '';
  if (!colorId) return null;
  const season = stateSeason(state);
  const colors = colorsOf(menu, season);
  if (colors.length && !colors.includes(colorId)) return null;

  const tension = Number(raw.tension);
  const [tensionLo, tensionHi] = tensionRange(menu);
  if (!Number.isFinite(tension) || tension < tensionLo || tension > tensionHi) return null;

  const decision = {
    colorId,
    tension,
    reason: raw.reason.replace(/[\r\n]+/g, ' ').trim().slice(0, 120),
  };

  const hasNext = raw.nextSeason !== undefined && raw.nextSeason !== null && raw.nextSeason !== false;
  if (!hasNext) {
    if (raw.seasonLength !== undefined && raw.seasonLength !== null) return null;
    return decision;
  }
  if (typeof raw.nextSeason !== 'string') return null;
  const seasons = seasonsOf(menu);
  if (seasons.length && !seasons.includes(raw.nextSeason)) return null;
  if (season && raw.nextSeason === season) return null;
  // 季末日才允许换季：seasonDay/seasonLength 可判定时必须到期。
  const day = Number(state?.seasonDay ?? state?.daysInSeason);
  const length = Number(state?.seasonLength);
  if (Number.isInteger(day) && Number.isInteger(length) && length > 0 && day < length - 1) return null;
  const [lo, hi] = seasonRange(menu);
  const seasonLength = Number(raw.seasonLength);
  if (!Number.isInteger(seasonLength) || seasonLength < lo || seasonLength > hi) return null;
  decision.nextSeason = raw.nextSeason;
  decision.seasonLength = seasonLength;
  return decision;
}
