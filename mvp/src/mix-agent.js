// 声部级 Bird Agent 的混音小步决策。每棵树共享一条声部总线，因此决策主体是
// flock/voice，而不是多只鸟同时抢写同一个 AudioParam。

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

const ACTION_DRIVE = Object.freeze({ rest: 0.2, perch: 0.35, explore: 1, balance: 0.65 });
const TIMBRE_KEYS = Object.freeze(['eqLowDb', 'eqMidDb', 'eqHighDb', 'reverbSend', 'pingPongSend']);

function hashUnit(day, treeId, salt = 0) {
  let h = (Math.floor(Number(day) || 0) + 1 + salt * 101) >>> 0;
  for (const char of String(treeId ?? 'tree')) h = Math.imul(h ^ char.charCodeAt(0), 2654435761) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function ensembleGainDelta(species, levels, clipWarn) {
  if (clipWarn) return -0.08;
  const rows = Object.entries(levels ?? {}).map(([id, level]) => ({
    id,
    rms: Math.max(1e-4, Number(level?.meanRms ?? level?.rms) || 0),
  }));
  const own = rows.find((row) => row.id === species)?.rms;
  if (!Number.isFinite(own) || rows.length < 2) return 0;
  const reference = Math.exp(rows.reduce((sum, row) => sum + Math.log(row.rms), 0) / rows.length);
  if (own < reference * 0.7) return 0.04;
  if (own > reference / 0.7) return -0.04;
  return 0;
}

export function decideVoiceMix({
  day = 0,
  treeId,
  species,
  current = {},
  home = {},
  levels = {},
  clipWarn = false,
  actionId = 'balance',
} = {}) {
  const drive = ACTION_DRIVE[actionId] ?? ACTION_DRIVE.balance;
  const key = TIMBRE_KEYS[Math.floor(hashUnit(day, treeId, 1) * TIMBRE_KEYS.length)];
  const signed = hashUnit(day, treeId, 2) < 0.5 ? -1 : 1;
  const isEq = key.endsWith('Db');
  const step = (isEq ? 0.75 : 0.04) * drive;
  const center = Number(home[key] ?? (isEq ? 0 : 0.08));
  const value = Number(current[key] ?? center);
  // 70% 探索、30% 回归声部初始性格：持续变化但不随机游走到参数边界。
  const drift = signed * step * 0.7 + (center - value) * 0.3;
  const timbreValue = isEq
    ? clamp(value + drift, -6, 6)
    : clamp(value + drift, 0, 0.45);
  const gainDelta = ensembleGainDelta(species, levels, clipWarn);
  const changes = [{ key, from: value, to: timbreValue, domain: 'timbre' }];
  if (gainDelta !== 0) {
    const gain = Number(current.gain ?? 1);
    const homeGain = Number(home.gain ?? 1);
    const gainLo = Math.max(0.7, homeGain - 0.2);
    const gainHi = Math.min(1.35, homeGain + 0.2);
    changes.push({
      key: 'gain', from: gain,
      to: clamp(gain + gainDelta + (homeGain - gain) * 0.08, gainLo, gainHi),
      domain: 'balance',
    });
  }
  return Object.freeze({
    day,
    treeId,
    actionId,
    changes: Object.freeze(changes.map(Object.freeze)),
    timbreExploration: clamp(Math.abs(timbreValue - value) / (isEq ? 1.5 : 0.08), 0, 1),
    reason: gainDelta
      ? '音色小步探索 · 响度向林群中位回归'
      : '音色小步探索 · 保持当前整体响度',
  });
}

export const VOICE_MIX_TIMBRE_KEYS = TIMBRE_KEYS;
