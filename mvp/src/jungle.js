// 生态 Jungle 鼓切片。
//
// 数据与编排思想提炼自同一作者的 dnber/services/jungleGenerator.ts：
// Amen / Think / Apache 的两小节十六分骨架、ghost note、swing 与句末 fill。
// pitchBranchId 被解释为鼓切片角色；stepIndex 是切片实际发声的时间格。

export const JUNGLE_ROLE_IDS = Object.freeze([
  'foundation', 'backbeat', 'roller', 'dub-space', 'fill',
]);

export const JUNGLE_ROLE_LABELS = Object.freeze([
  '根鼓', '反拍', '滚镲', '留白', '切分',
]);

const PHRASES = Object.freeze([
  // kind: kick/snare/hat/open/perc；step 为两小节内十六分位置 0..31。
  Object.freeze([
    [0, 'kick', 1], [2, 'hat', .46], [3, 'snare', .25], [4, 'snare', 1],
    [6, 'kick', .68], [7, 'snare', .31], [8, 'hat', .48], [10, 'kick', .82],
    [11, 'snare', .27], [12, 'snare', .98], [14, 'open', .54], [15, 'snare', .38],
    [16, 'kick', .94], [18, 'hat', .43], [19, 'snare', .28], [20, 'snare', 1],
    [22, 'kick', .7], [23, 'snare', .3], [24, 'kick', .72], [26, 'hat', .45],
    [27, 'snare', .28], [28, 'snare', .98], [30, 'perc', .5], [31, 'snare', .4],
  ]),
  Object.freeze([
    [0, 'kick', .96], [2, 'hat', .43], [4, 'snare', .96], [5, 'snare', .23],
    [7, 'kick', .62], [8, 'hat', .46], [10, 'kick', .78], [11, 'snare', .26],
    [12, 'snare', .98], [14, 'hat', .44], [15, 'snare', .3], [16, 'kick', .9],
    [19, 'snare', .25], [20, 'snare', .96], [22, 'kick', .66], [23, 'snare', .25],
    [25, 'kick', .62], [27, 'snare', .28], [28, 'snare', .98], [30, 'open', .47],
  ]),
  Object.freeze([
    [0, 'kick', .98], [3, 'snare', .25], [4, 'snare', .98], [6, 'kick', .68],
    [8, 'hat', .45], [10, 'kick', .77], [12, 'snare', .98], [14, 'open', .5],
    [15, 'snare', .31], [16, 'kick', .9], [18, 'perc', .45], [20, 'snare', 1],
    [22, 'kick', .72], [24, 'hat', .43], [27, 'snare', .28], [28, 'snare', .98],
    [30, 'perc', .46], [31, 'snare', .32],
  ]),
]);

// 与 dnber/services/previewPlayer.ts 的 DRUM_TO_AMEN_STEP 使用同一份 32-slice
// Amen 地址。每个 cell 只触发一个 slice；break 的节奏来自跨时间格的 Sequence，
// 不再由单个 cell 额外生成一整小节。
const ROLE_AMEN_STEPS = Object.freeze([0, 4, 2, 14, 30]);

export function jungleSliceForCell({ roleId = 0, stepIndex = 0, tension = 0.3 } = {}) {
  const role = Math.max(0, Math.min(JUNGLE_ROLE_IDS.length - 1,
    Math.trunc(Number.isFinite(Number(roleId)) ? Number(roleId) : 0)));
  const step = Math.max(0, Math.trunc(Number.isFinite(Number(stepIndex)) ? Number(stepIndex) : 0));
  const t = clamp01(tension);
  let amenStep = ROLE_AMEN_STEPS[role];
  if (role === 4) amenStep = [22, 26, 30, 3][step % 4];
  return {
    amenStep,
    sliceSteps: role === 3 ? 2.2 : (role === 4 ? 1.65 : 1.35),
    velocity: clamp01((role === 2 ? .72 : .92) + t * .08),
    playbackRate: .9 + t * .16,
  };
}

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

function seeded(seed) {
  let state = (Math.trunc(Number(seed)) || 1) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roleAllows(roleId, kind, strength, tension) {
  if (kind === 'kick' || (kind === 'snare' && strength >= .9)) return true; // 骨架永不丢
  if (roleId === 0) return kind === 'hat' ? strength >= .43 : strength >= .3;
  if (roleId === 1) return kind === 'snare' || (kind === 'kick' && strength >= .75);
  if (roleId === 2) return kind === 'hat' || kind === 'open' || strength >= .62;
  if (roleId === 3) return strength >= .68 || kind === 'open';
  return strength >= .23 || tension >= .45; // fill：保留 ghost/perc
}

/**
 * 生成一小节 Jungle cue；offsetBeats 为相对 cue 起点的 0..4 拍。
 * 强拍骨架确定，ghost/fill 由 seed 决定，因此相同 cell 可复现、Agent 移格才改变重音上下文。
 */
export function jungleCuePlan({ roleId = 0, stepIndex = 0, tension = 0.3, seed = 1 } = {}) {
  const safeStep = Number.isFinite(Number(stepIndex)) ? Math.trunc(Number(stepIndex)) : 0;
  const safeSeed = Number.isFinite(Number(seed)) ? Math.trunc(Number(seed)) : 1;
  const role = Math.max(0, Math.min(JUNGLE_ROLE_IDS.length - 1, Math.trunc(Number(roleId)) || 0));
  const t = clamp01(tension);
  const rand = seeded((safeStep + 1) * 4099 + role * 131 + safeSeed);
  const phrase = PHRASES[Math.abs(safeSeed + Math.trunc(safeStep / 4)) % PHRASES.length];
  const barOffset = (Math.abs(Math.trunc(safeStep / 4)) % 2) * 16;
  const swing = .018 + t * .045;
  const hits = [];
  for (const [step, kind, strength] of phrase) {
    if (step < barOffset || step >= barOffset + 16) continue;
    if (!roleAllows(role, kind, strength, t)) continue;
    const ghost = strength < .55;
    if (ghost && rand() > .42 + t * .48 + (role === 4 ? .18 : 0)) continue;
    const local = step - barOffset;
    hits.push({
      kind,
      offsetBeats: local / 4 + (local % 2 === 1 ? swing : 0),
      velocity: clamp01((.38 + strength * .58) * (.78 + t * .22)),
      ghost,
    });
  }
  // 每小节最后一拍只由 fill 角色增加可读的三连式收束，避免所有鸟都疯狂碎拍。
  if (role === 4) {
    const count = t >= .55 ? 4 : 2;
    for (let i = 0; i < count; i += 1) {
      hits.push({
        kind: i % 2 ? 'perc' : 'snare',
        offsetBeats: 3.5 + i * (.5 / count),
        velocity: .38 + i * (.09 + t * .03),
        ghost: i === 0,
      });
    }
  }
  return hits.sort((a, b) => a.offsetBeats - b.offsetBeats || a.kind.localeCompare(b.kind));
}

export function jungleRoleDiversity(cells = [], roleCount = JUNGLE_ROLE_IDS.length) {
  const roles = new Set((cells ?? [])
    .map((cell) => Number(cell?.pitchBranchId))
    .filter((role) => Number.isInteger(role) && role >= 0 && role < roleCount));
  const onsets = new Set((cells ?? [])
    .map((cell) => Number(cell?.stepIndex))
    .filter(Number.isInteger));
  if (!onsets.size) return 0;
  return roles.size / Math.min(roleCount, onsets.size);
}
