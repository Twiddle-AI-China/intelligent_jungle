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

// 当日均 RMS 低于此值（约 −60dB）时视为该声部当天没有真正发声。这类行不能进
// 参考值：一条长期 Mute / 极稀疏的轨会把几何均值拉低一个数量级，从而把其余
// 每一条能出声的轨都判成"过响"，整片森林一起被压到各自下限。
const AUDIBLE_RMS_FLOOR = 1e-3;

function ensembleGainDelta(species, levels, clipWarn) {
  if (clipWarn) return -0.08;
  const rows = Object.entries(levels ?? {})
    .map(([id, level]) => ({ id, rms: Number(level?.meanRms ?? level?.rms) || 0 }))
    .filter((row) => row.rms >= AUDIBLE_RMS_FLOOR);
  const own = rows.find((row) => row.id === species)?.rms;
  // 自己当天没出声 → 无从判断平衡，保持不动（既不补也不扣）。
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
    const balanceLo = Math.max(0.7, homeGain - 0.2);
    // 平衡用途只允许在 home±0.2 内小步走；削波是安全事件，必须有真正的衰减权限
    // （0.55 ≈ −5dB）。离开削波后不一步跳回 balanceLo，由回家项平滑走上来，
    // 避免"刚松手就又削波"的振荡。
    const gainLo = clipWarn ? 0.55 : Math.min(balanceLo, gain);
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
