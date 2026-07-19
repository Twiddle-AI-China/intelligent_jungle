// Master 的同步兜底策略。菜单与观测量全部由集成方注入，本模块不依赖 config。

const DEFAULT_HEALTH_FLOOR = 0.4;
const DEFAULT_SIMILARITY_HIGH = 0.82;
const DEFAULT_LOW_STREAK_DAYS = 2;

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const integer = (value, fallback = 0) => Number.isInteger(Number(value)) ? Number(value) : fallback;

function seasonNames(menu) {
  return menu?.seasonPalettes && typeof menu.seasonPalettes === 'object'
    ? Object.keys(menu.seasonPalettes)
    : [];
}

function paletteOptions(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.keys(value);
  return value == null ? [] : [value];
}

function progressionFor(menu, state) {
  const progressions = Array.isArray(menu?.progressions) ? menu.progressions : [];
  if (!progressions.length) return [];
  if (!Array.isArray(progressions[0])) return progressions;
  const explicit = integer(state?.currentProgression, -1);
  if (explicit >= 0 && Array.isArray(progressions[explicit])) return progressions[explicit];
  const index = seasonNames(menu).indexOf(state?.currentSeason);
  return Array.isArray(progressions[index]) ? progressions[index] : progressions[0];
}

function seasonRange(menu) {
  const range = Array.isArray(menu?.seasonLengthRange) ? menu.seasonLengthRange : [];
  const min = Math.max(1, integer(range[0], 2));
  return [min, Math.max(min, integer(range[1], 8))];
}

function nextSeasonChoice(menu, state) {
  const names = seasonNames(menu);
  if (!names.length) return null;
  const currentIndex = names.indexOf(state?.currentSeason);
  const nextSeason = names[(currentIndex < 0 ? 0 : currentIndex + 1) % names.length];
  const options = paletteOptions(menu.seasonPalettes[nextSeason]);
  if (!options.length) return null;
  return { season: nextSeason, palette: options[0] };
}

function balanceState(observations, state, menu) {
  const scores = Array.isArray(observations?.treeScores) ? observations.treeScores : [];
  const flatScores = scores.flatMap((entry) => Array.isArray(entry) ? entry : [entry])
    .map(Number).filter(Number.isFinite);
  const lowest = flatScores.length ? Math.min(...flatScores) : 1;
  const healthFloor = finite(menu?.healthBand?.[0] ?? menu?.healthFloor, DEFAULT_HEALTH_FLOOR);

  // 只给当日四树分数时，以当前地形已维持的天数作为保守的连续性证据，
  // 避免一次偶发低分就跳步；若树分携带短历史，则直接读其尾部连败。
  let streak = 0;
  if (scores.some(Array.isArray)) {
    const histories = scores.filter(Array.isArray);
    streak = Math.max(0, ...histories.map((history) => {
      let count = 0;
      for (let i = history.length - 1; i >= 0 && finite(history[i], 1) < healthFloor; i -= 1) count += 1;
      return count;
    }));
  }
  if (!streak && lowest < healthFloor) streak = Math.max(1, integer(state?.daysSinceChange, 0));
  return { lowest, healthFloor, persistentlyLow: lowest < healthFloor && streak >= DEFAULT_LOW_STREAK_DAYS };
}

function stepDecision(menu, state, reason, jump = false) {
  const progression = progressionFor(menu, state);
  const current = Math.max(0, integer(state?.currentStep, 0));
  if (jump && progression.length > 2) {
    return {
      advanceStep: false,
      jumpToStep: (current + 2) % progression.length,
      reason,
    };
  }
  return { advanceStep: true, reason };
}

/**
 * 纯函数 master 策略：硬到期换季 > 持续失衡跳步 > 相似度疲劳换季 > 顺走。
 * 任何返回值最多改变 progression 步或季节色彩中的一个维度。
 */
export function decideMaster({ menu = {}, state = {}, observations = {} } = {}) {
  const [minDays, maxDays] = seasonRange(menu);
  const daysInSeason = Math.max(0, integer(state.daysInSeason, 0));
  const cooldownDays = Math.max(0, integer(menu.cooldownDays, 0));
  const cooldownReady = Math.max(0, integer(state.daysSinceChange, 0)) >= cooldownDays;
  const nextSeason = nextSeasonChoice(menu, state);
  const balance = balanceState(observations, state, menu);
  const similarity = Math.max(0, Math.min(1, finite(observations.patternSimilarity, 0)));

  if (daysInSeason >= maxDays && cooldownReady && nextSeason) {
    return {
      advanceStep: false,
      changeSeason: nextSeason.season,
      nextPalette: nextSeason.palette,
      reason: '季节已到菜单上限，切换到下一种生态气候',
    };
  }
  if (balance.persistentlyLow) {
    return stepDecision(menu, state, '最低树况持续低于健康带，先换一步恢复均衡', true);
  }
  if (daysInSeason >= minDays && similarity >= DEFAULT_SIMILARITY_HIGH && cooldownReady && nextSeason) {
    return {
      advanceStep: false,
      changeSeason: nextSeason.season,
      nextPalette: nextSeason.palette,
      reason: '同一生态景观相似度持续偏高，换季恢复新鲜感',
    };
  }
  if (daysInSeason >= maxDays && !cooldownReady) {
    return stepDecision(menu, state, '虽已到期但仍在换季冷却期，先平稳顺走一步');
  }
  return stepDecision(menu, state, '树况稳定，沿既定生态路径顺走一步');
}

export const decideMasterPolicy = decideMaster;
export const masterPolicy = decideMaster;

export function normalizeMasterDecision(raw, menu = {}, state = {}) {
  if (!raw || typeof raw !== 'object' || typeof raw.advanceStep !== 'boolean') return null;
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) return null;
  const hasJump = raw.jumpToStep !== undefined && raw.jumpToStep !== null;
  const hasSeason = raw.changeSeason !== undefined && raw.changeSeason !== null && raw.changeSeason !== false;
  if ((raw.advanceStep && hasJump) || (hasSeason && (raw.advanceStep || hasJump))) return null;

  const decision = {
    advanceStep: raw.advanceStep,
    reason: raw.reason.replace(/[\r\n]+/g, ' ').trim().slice(0, 120),
  };
  if (hasJump) {
    const step = Number(raw.jumpToStep);
    const progression = progressionFor(menu, state);
    if (!Number.isInteger(step) || step < 0 || step >= progression.length) return null;
    decision.jumpToStep = step;
  }
  if (hasSeason) {
    if (typeof raw.changeSeason !== 'string' || typeof raw.nextPalette !== 'string') return null;
    const palettes = menu?.seasonPalettes;
    if (!palettes || !Object.hasOwn(palettes, raw.changeSeason)) return null;
    if (!paletteOptions(palettes[raw.changeSeason]).includes(raw.nextPalette)) return null;
    const [minDays] = seasonRange(menu);
    const cooldownDays = Math.max(0, integer(menu?.cooldownDays, 0));
    if (integer(state?.daysInSeason, 0) < minDays) return null;
    if (integer(state?.daysSinceChange, 0) < cooldownDays) return null;
    decision.changeSeason = raw.changeSeason;
    decision.nextPalette = raw.nextPalette;
  } else if (raw.nextPalette !== undefined && raw.nextPalette !== null) {
    return null;
  }
  return decision;
}
