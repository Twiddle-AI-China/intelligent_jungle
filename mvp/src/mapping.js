// mvp/src/mapping.js —— 生态 → 音乐的唯一翻译点。
// 纯函数、无状态、无 Web Audio / DOM 依赖：输入生态词汇（枝号、同枝栖鸟数、驻留时长、
// 相位）与当日和弦（harmony.js），输出音乐参数（MIDI 音高、力度、时值、滤波宏）。
// world 与 agent 都不知道这层存在；audio 只消费这里的输出。

import { CONFIG } from './config.js';

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

function resolveSpecies(speciesOrTreeId, cfg = CONFIG) {
  if (speciesOrTreeId == null) return null;
  if (typeof speciesOrTreeId === 'object') {
    return speciesOrTreeId.species ?? speciesOrTreeId.treeId ?? null;
  }
  const key = String(speciesOrTreeId);
  if (cfg.species?.[key]) return key;
  const tree = cfg.trees?.find((entry) => entry.id === key);
  return tree?.species ?? key;
}

function notesForSpecies(chord, species) {
  if (species === 'melody' && Array.isArray(chord?.melodyNotes) && chord.melodyNotes.length) {
    return chord.melodyNotes;
  }
  // B1：pad/bass/texture 优先走放宽后的当日至 5 音菜单（speciesMenus）；
  // 手搓 chord 无 speciesMenus 时回退 chord.notes（旧契约不变）。
  const menu = chord?.speciesMenus?.[species];
  if (Array.isArray(menu) && menu.length) return menu;
  return chord?.notes ?? [];
}

/** 纵向枝数量；runner 槽 id 从此起编。 */
export function verticalBranchCount(cfg = CONFIG) {
  return Array.isArray(cfg.tree?.branches) ? cfg.tree.branches.length : 0;
}

/** 全部 runner 栖节点总数。 */
export function runnerNodeTotal(cfg = CONFIG) {
  const runners = Array.isArray(cfg.tree?.runners) ? cfg.tree.runners : [];
  return runners.reduce((sum, runner) => sum + Math.max(0, Math.floor(Number(runner.nodeCount) || 0)), 0);
}

/**
 * branchId → runner 元数据（形态索引，不含音高）。
 * @returns {{ runnerId: number, nodeIndex: number, nodeCount: number } | null}
 */
export function runnerMetaFromBranchId(branchId, cfg = CONFIG) {
  if (!Number.isInteger(branchId)) return null;
  const base = verticalBranchCount(cfg);
  if (branchId < base) return null;
  const runners = Array.isArray(cfg.tree?.runners) ? cfg.tree.runners : [];
  let cursor = base;
  for (const runner of runners) {
    const nodeCount = Math.max(0, Math.floor(Number(runner.nodeCount) || 0));
    if (branchId < cursor + nodeCount) {
      return {
        runnerId: Number.isInteger(runner.id) ? runner.id : 0,
        nodeIndex: branchId - cursor,
        nodeCount,
      };
    }
    cursor += nodeCount;
  }
  return null;
}

export function isRunnerBranchId(branchId, cfg = CONFIG) {
  return runnerMetaFromBranchId(branchId, cfg) != null;
}

/**
 * 枝号 → MIDI 音高。
 * pad/bass/texture：speciesMenus 放宽音级菜单（缺省回退 chord.notes）；melody：调式音阶窗。
 * C3：bass runner 节点 = 和弦音；西端 nodeIndex 0 = 根音（notes[0]）。
 * 第三参可选 species 或 treeId（评测器按声部忠实计量）；缺省保持旧契约=和弦音。
 */
export function noteFromBranch(branchId, chord, speciesOrTreeId = null, cfg = CONFIG) {
  const species = resolveSpecies(speciesOrTreeId, cfg);
  const notes = notesForSpecies(chord, species);
  if (!notes.length) return 0;

  const runner = runnerMetaFromBranchId(branchId, cfg);
  if (runner && (species === 'bass' || species == null)) {
    // 西端/起点 → 根音；其余节点沿和弦音循环（纵向枝仍走下方夹取路径）。
    if (runner.nodeIndex === 0) return notes[0];
    return notes[runner.nodeIndex % notes.length];
  }
  // species 显式非 bass 却落在 runner id 上：仍按菜单夹取，避免越界。
  if (runner) {
    return notes[clamp(runner.nodeIndex, 0, notes.length - 1)];
  }

  const idx = clamp(Math.trunc(branchId), 0, notes.length - 1);
  return notes[idx];
}

export function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

// 力度三档：同枝栖鸟数 → 力度。0 只不该发声，返回 0。
export function velocityFromPerchCount(count, cfg = CONFIG.mapping) {
  if (count >= cfg.choirCount) return cfg.velocityChoir;
  if (count >= cfg.duetCount) return cfg.velocityDuet;
  if (count >= 1) return cfg.velocitySolo;
  return 0;
}

// 时值 = 驻留时长：驻留越久音越长，夹在可闻区间内。离枝时以此为收尾时值。
export function durationFromDwell(dwellSeconds, cfg = CONFIG.mapping) {
  if (!(dwellSeconds > 0)) return 0;
  return Math.min(Math.max(dwellSeconds, cfg.dwellMinAudible), cfg.dwellMaxDuration);
}

// 相位 → 音频宏参数：亮度（滤波截止缩放）与整体安静程度。
export function dayNightAudioMacros(daylight, cfg = CONFIG.audio) {
  const d = clamp(daylight);
  return {
    filterCutoffHz: cfg.filterBaseHz + d * cfg.filterDaylightSpan,
    gainScale: cfg.nightGainScale + d * (1 - cfg.nightGainScale),
  };
}

// perch 事件载荷 + 当日和弦 → 一条完整的发声指令（audio 的唯一输入形状）。
// registerOffset：双树音区错开（pad 低中、melody 中高）。
export function perchToNote(perchEvent, chord, cfg = CONFIG, registerOffset = 0) {
  const species = resolveSpecies(perchEvent?.treeId ?? perchEvent?.species, cfg);
  return {
    midi: noteFromBranch(perchEvent.branchId, chord, species, cfg) + registerOffset,
    velocity: velocityFromPerchCount(perchEvent.perchedOnBranch, cfg.mapping),
  };
}

// pad 与其它物种同样严格遵守「枝=音」。这里仅聚合当前栖鸟，并在换和弦时
// 为同一枝音选择离上一帧最近的八度；绝不按 birdId 补写根/五/色彩角色。
export function padVoicingAssignments(perches, chord, {
  registerOffset = 0, minMidi = 52, maxMidi = 76, previous = new Map(),
} = {}) {
  const entries = (Array.isArray(perches) ? perches : [])
    .filter((entry) => Number.isInteger(entry?.birdId) && Number.isInteger(entry?.branchId))
    .sort((a, b) => a.birdId - b.birdId);
  return entries.map((entry) => {
    const base = noteFromBranch(entry.branchId, chord, 'pad') + registerOffset;
    const candidates = [];
    for (let midi = base - 36; midi <= base + 36; midi += 12) {
      if (midi >= minMidi && midi <= maxMidi) candidates.push(midi);
    }
    if (!candidates.length) candidates.push(Math.max(minMidi, Math.min(maxMidi, base)));
    const priorValue = previous instanceof Map ? previous.get(entry.birdId) : previous?.[entry.birdId];
    const prior = typeof priorValue === 'object' ? priorValue.midi : priorValue;
    const target = Number.isFinite(prior) ? prior : base;
    const midi = candidates.reduce((best, candidate) => {
      const cost = Math.abs(candidate - target);
      const bestCost = Math.abs(best - target);
      return cost < bestCost ? candidate : best;
    }, candidates[0]);
    return { ...entry, midi, role: `branch-${entry.branchId}` };
  });
}

// unperch 事件载荷 + 当日和弦 → 收尾时值。
export function unperchToRelease(unperchEvent, chord, cfg = CONFIG, registerOffset = 0) {
  const species = resolveSpecies(unperchEvent?.treeId ?? unperchEvent?.species, cfg);
  return {
    midi: noteFromBranch(unperchEvent.branchId, chord, species, cfg) + registerOffset,
    durationSeconds: durationFromDwell(unperchEvent.dwellTime, cfg.mapping),
  };
}
