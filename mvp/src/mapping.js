// mvp/src/mapping.js —— 生态 → 音乐的唯一翻译点。
// 纯函数、无状态、无 Web Audio / DOM 依赖：输入生态词汇（枝号、同枝栖鸟数、驻留时长、
// 相位）与当日和弦（harmony.js），输出音乐参数（MIDI 音高、力度、时值、滤波宏）。
// world 与 agent 都不知道这层存在；audio 只消费这里的输出。

import { CONFIG } from './config.js';

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

// 枝号 → MIDI 音高。枝干 = 当日和弦内音（每枝一音、按音高排列，黎明随进行切换）。
export function noteFromBranch(branchId, chord) {
  const idx = clamp(Math.trunc(branchId), 0, chord.notes.length - 1);
  return chord.notes[idx];
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
  return {
    midi: noteFromBranch(perchEvent.branchId, chord) + registerOffset,
    velocity: velocityFromPerchCount(perchEvent.perchedOnBranch, cfg.mapping),
  };
}

// unperch 事件载荷 + 当日和弦 → 收尾时值。
export function unperchToRelease(unperchEvent, chord, cfg = CONFIG, registerOffset = 0) {
  return {
    midi: noteFromBranch(unperchEvent.branchId, chord) + registerOffset,
    durationSeconds: durationFromDwell(unperchEvent.dwellTime, cfg.mapping),
  };
}
