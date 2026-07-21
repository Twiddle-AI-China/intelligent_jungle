// 生态 Jungle / Amen 切片地址。
//
// stepIndex 决定原始 break 的切片位置；pitchBranchId 只决定移调。
// 五枝不再伪装成 kick/snare/hat 角色，也不会触发程序化鼓。音频层按这里给出的
// 音频层用颗粒重采样读取真实 WAV：tempoRate 只推进源时间轴，
// pitchRate 只改变颗粒内移调，因而五枝读取同样的 Amen 拍长并占满同一步。

export const JUNGLE_PITCH_SEMITONES = Object.freeze([-7, -3, 0, 3, 7]);

export const JUNGLE_PITCH_LABELS = Object.freeze([
  '−7st', '−3st', '原调', '+3st', '+7st',
]);

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

/**
 * 16 个世界时间格均匀读取 dnber 的 32-slice Amen 网格。最后一格停在 29，
 * 为最高移调保留足够源采样，避免靠近文件尾时被迫缩短。
 */
export function jungleSliceForCell({
  pitchBranchId = 0,
  roleId,
  stepIndex = 0,
  tension = 0.3,
  masterBpm = 60,
  tempoMultiplier = 2,
  amenDurationSeconds = 2.742857142857143,
  amenNativeBeats = 8,
} = {}) {
  const requestedPitch = Number.isFinite(Number(pitchBranchId)) ? Number(pitchBranchId) : Number(roleId);
  const pitchIndex = Math.max(0, Math.min(
    JUNGLE_PITCH_SEMITONES.length - 1,
    Math.trunc(Number.isFinite(requestedPitch) ? requestedPitch : 0),
  ));
  const step = Math.max(0, Math.trunc(Number.isFinite(Number(stepIndex)) ? Number(stepIndex) : 0));
  const semitones = JUNGLE_PITCH_SEMITONES[pitchIndex];
  const jungleBpm = Math.max(1, Number(masterBpm) || 60)
    * Math.max(1, Number(tempoMultiplier) || 2);
  const outputSeconds = 60 / jungleBpm;
  const nativeBeatSeconds = Math.max(0.001, Number(amenDurationSeconds) || 2.742857142857143)
    / Math.max(1, Number(amenNativeBeats) || 8);
  const pitchRate = 2 ** (semitones / 12);
  const tempoRate = nativeBeatSeconds / outputSeconds;
  return {
    amenStep: Math.min(29, (step % 16) * 2),
    pitchIndex,
    semitones,
    jungleBpm,
    nativeBeatSeconds,
    tempoRate,
    pitchRate,
    // 保留字段名给音频节点；只含移调，tempo 由颗粒源位置独立推进。
    playbackRate: pitchRate,
    outputSeconds,
    velocity: 0.92 + clamp01(tension) * 0.08,
  };
}

/**
 * 将一个固定输出时值的 chop 拆成交叉颗粒。每粒的输出起点按
 * tempoRate 映射到 Amen 源时间轴，而粒内 playbackRate 只使用 pitchRate。
 * 这是 Web Audio 原生节点下将“移调”与“整片时值”分离的最小实现。
 */
export function jungleGrainPlan(slice, {
  grainSeconds = 0.1,
  overlap = 0.5,
} = {}) {
  const total = Math.max(0.001, Number(slice?.outputSeconds) || 0.5);
  const grain = Math.max(0.02, Math.min(total, Number(grainSeconds) || 0.1));
  const overlapRatio = Math.max(0.1, Math.min(0.8, Number(overlap) || 0.5));
  const hop = grain * (1 - overlapRatio);
  const tempoRate = Math.max(0.001, Number(slice?.tempoRate) || 1);
  const pitchRate = Math.max(0.001, Number(slice?.pitchRate) || 1);
  const grains = [];
  for (let outputOffset = 0; outputOffset < total - 1e-6; outputOffset += hop) {
    const outputDuration = Math.min(grain, total - outputOffset);
    grains.push({
      outputOffset,
      outputDuration,
      sourceOffset: outputOffset * tempoRate,
      sourceTimelineDuration: outputDuration * tempoRate,
      sourceDuration: outputDuration * pitchRate,
      playbackRate: pitchRate,
    });
  }
  return grains;
}

// 配置/评分字段仍叫 roleDiversity 以保持存档与 LLM 契约兼容；实际语义已是
// “同一天用到多少个移调枝”。
export function jungleRoleDiversity(cells = [], pitchCount = JUNGLE_PITCH_SEMITONES.length) {
  const pitches = new Set((cells ?? [])
    .map((cell) => Number(cell?.pitchBranchId))
    .filter((pitch) => Number.isInteger(pitch) && pitch >= 0 && pitch < pitchCount));
  const onsets = new Set((cells ?? [])
    .map((cell) => Number(cell?.stepIndex))
    .filter(Number.isInteger));
  if (!onsets.size) return 0;
  return pitches.size / Math.min(pitchCount, onsets.size);
}
