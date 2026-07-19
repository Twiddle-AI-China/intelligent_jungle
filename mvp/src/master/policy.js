// Master 的同步兜底策略与新菜单校验。
// 契约（docs/harmony-season-redesign.md §3）：季 = 一个固定和声骨架（8–16 昼夜），
// 每黎明 master 只为次日选一档「色彩」colorId（当季菜单内）与张力预算 tension(0..1)；
// 仅在季末日额外输出 nextSeason 与 seasonLength。顺走/跳步旧菜单已废除。
// 菜单与观测量全部由集成方注入，本模块不依赖 config。

const DEFAULT_SEASON_LENGTH_RANGE = Object.freeze([8, 16]);

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

// 归一化后的菜单形态，供 normalizeMasterInput / 校验共用。
export function canonMasterMenu(menu = {}) {
  return {
    seasons: seasonsOf(menu),
    colorsBySeason: colorsBySeason(menu),
    seasonLengthRange: seasonRange(menu),
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
const BORED_DAYS = 3;          // 新鲜：同一色彩档连续天数腻值阈值
const SIMILARITY_BORED = 0.82; // 新鲜：pattern 相似度腻值等价
const SEASON_COOLDOWN_DAYS = 2;// 平稳：换季后冷却天数

// 历史读取沿用旧约定：treeScores/harmonyScores 的每个元素可为当日值或短历史数组；
// 状态记忆（连续低分天数/同档天数）全部由 state/observations 传入，不开全局变量。
function trailingLow(observations = {}) {
  let maxStreak = 0;
  let lowestToday = 1;
  let lowLabel = null;
  for (const [label, list] of [['treeScores', observations.treeScores], ['harmonyScores', observations.harmonyScores]]) {
    if (!Array.isArray(list)) continue;
    list.forEach((entry, index) => {
      const hist = (Array.isArray(entry) ? entry : [entry]).map(Number).filter(Number.isFinite);
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
 * 纯函数 master 策略（规则兜底，eco-incentive-design §6 三观测量）：
 * - 平稳基线：色彩档按日轮转；tension 随季节进度线性爬升（季首 0 → 季末 1）；
 *   季末日选下一季（菜单顺序轮转）并给范围中值的季长；换季后冷却 2 天不动任何维。
 * - 均衡：某树分连续 LOW_STREAK_DAYS 天低于 LOW_SCORE_FLOOR → 换下一色彩档（非轮转原档）。
 * - 新鲜：同一色彩档连续 BORED_DAYS 天（或 pattern 相似度 ≥ SIMILARITY_BORED）→ 换档。
 * - 一次只改一维：换档日不动 tension；单日低分只小幅上调 tension（+0.1）不换档。
 */
export function decideMaster({ menu = {}, state = {}, observations = {} } = {}) {
  const season = stateSeason(state);
  const colors = colorsOf(menu, season);
  const seasonDay = stateSeasonDay(state);
  const length = stateSeasonLength(state, menu);
  const ramp = Math.min(1, Math.max(0, seasonDay / Math.max(1, length - 1)));
  const tensionBase = Math.round(ramp * 100) / 100;
  const current = typeof state.currentColorId === 'string' && colors.includes(state.currentColorId)
    ? state.currentColorId : null;
  const rotationColor = colors.length ? colors[seasonDay % colors.length] : (current ?? 'base');
  const nextColorOf = (from) => {
    if (colors.length < 2) return from ?? rotationColor;
    const idx = colors.indexOf(from);
    return colors[(idx < 0 ? seasonDay + 1 : idx + 1) % colors.length];
  };

  if (isSeasonFinalDay(state, menu)) {
    const seasons = seasonsOf(menu);
    const [lo, hi] = seasonRange(menu);
    const next = seasons.length
      ? seasons[(seasons.indexOf(season) < 0 ? 0 : seasons.indexOf(season) + 1) % seasons.length]
      : null;
    if (next) {
      return {
        colorId: current ?? rotationColor,
        tension: tensionBase,
        nextSeason: next,
        seasonLength: Math.round((lo + hi) / 2),
        reason: '季末日：选定菜单中的下一季，季长取范围中值',
      };
    }
  }

  // 平稳：换季后冷却期内不做任何主动调整。
  const daysSinceChange = Number(state.daysSinceChange);
  if (Number.isFinite(daysSinceChange) && daysSinceChange >= 0 && daysSinceChange < SEASON_COOLDOWN_DAYS) {
    return {
      colorId: current ?? rotationColor,
      tension: tensionBase,
      reason: `换季冷却期（第 ${Math.floor(daysSinceChange) + 1}/${SEASON_COOLDOWN_DAYS} 天），维持现状不动任何维`,
    };
  }

  const { maxStreak, lowestToday, lowLabel } = trailingLow(observations);
  const daysInColor = Math.max(0, integer(state.daysInColor ?? state.colorDays ?? state.sameColorDays, 0));
  const similarity = Math.min(1, Math.max(0, Number(observations.patternSimilarity) || 0));
  const bored = Math.max(daysInColor, similarity >= SIMILARITY_BORED ? BORED_DAYS : 0);

  // 均衡：连续低分 → 换下一档（一次一维，tension 保持基准）。
  if (maxStreak >= LOW_STREAK_DAYS && colors.length > 1) {
    const from = current ?? rotationColor;
    return {
      colorId: nextColorOf(from),
      tension: tensionBase,
      reason: `${lowLabel} 连续${maxStreak}日低分，换档 ${from}→${nextColorOf(from)}（一次一维，tension 不动）`,
    };
  }
  // 新鲜：同档腻值累积 → 换档。
  if (bored >= BORED_DAYS && colors.length > 1) {
    const from = current ?? rotationColor;
    const why = daysInColor >= BORED_DAYS ? `同一色彩档已连续${daysInColor}天` : `pattern 相似度 ${similarity.toFixed(2)} 偏高`;
    return {
      colorId: nextColorOf(from),
      tension: tensionBase,
      reason: `${why}，换档 ${from}→${nextColorOf(from)} 恢复新鲜`,
    };
  }
  // 均衡（单日低分）：只小幅上调 tension，不换档。
  if (lowestToday < LOW_SCORE_FLOOR) {
    return {
      colorId: current ?? rotationColor,
      tension: Math.min(1, Math.round((ramp + 0.1) * 100) / 100),
      reason: `${lowLabel} 当日低分 ${lowestToday.toFixed(2)}，张力小幅上调（一次一维，色彩档不动）`,
    };
  }
  return {
    colorId: rotationColor,
    tension: tensionBase,
    reason: `树况平稳：色彩档按日轮转，张力随季节进度爬升（季内第 ${seasonDay + 1}/${length} 天）`,
  };
}

export const decideMasterPolicy = decideMaster;
export const masterPolicy = decideMaster;

/**
 * 新菜单校验：colorId 必须在当季色彩菜单内（菜单缺省时宽容放行），
 * tension 必须是 [0,1] 的有限数；nextSeason/seasonLength 仅季末日合法，
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
  if (!Number.isFinite(tension) || tension < 0 || tension > 1) return null;

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
