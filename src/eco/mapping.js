// 生态中间属性 → 音乐参数的固定映射层（设计 v3.3 §2）。
// 纯函数、无状态、无 Web Audio 依赖：输入生态状态，输出声音参数。
// agent 永远不接触这里；右列（音乐参数）只存在于本模块的设计里。

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

// 四季 ↔ 和弦色彩：季节索引 0=春 1=夏 2=秋 3=冬。
export const SEASONS = Object.freeze(['spring', 'summer', 'autumn', 'winter']);
export const SEASON_TO_CHORD = Object.freeze({
  spring: 'major',
  summer: 'sus4',
  autumn: 'minor7',
  winter: 'minor',
});

// 力度三档：同点栖鸟数 → 力度。
export function velocityFromPerchCount(count) {
  if (count >= 3) return 1.0;
  if (count === 2) return 0.68;
  if (count === 1) return 0.42;
  return 0;
}

// 8D 关系（光环运动）→ 音色。与 src/audio-engine.js 的 RELATION_TO_SYNTH 契约一致：
// 返回的参数键就是 SynthVoice.setTimbre 消费的键。Spark 前由 Web Audio 合成器代驾，
// 映射契约不变，届时整体换解码器即可。
export function timbreFromHalo(relations) {
  const r = relations;
  return {
    filterCutoff: 100 + (r[0] * 0.5 + 0.5) ** 2 * 5900,      // compactness 100Hz-6kHz
    filterResonance: 0.5 + (r[4] * 0.5 + 0.5) * 11.5,        // circulation Q 0.5-12
    detuneSpread: (1 - (r[1] * 0.5 + 0.5)) * 100,            // alignment 0-100 cents
    delayFeedback: (r[2] * 0.5 + 0.5) * 0.6,                 // expansion 0-0.6
    delayTime: 0.1 + (r[2] * 0.5 + 0.5) * 0.4,               // expansion 0.1-0.5s
    oscillatorLevel: 0.2 + (r[3] * 0.5 + 0.5) * 0.8,         // motionEnergy 0.2-1.0
    subOscMix: (1 - (r[0] * 0.5 + 0.5)) * 0.4,               // 松散时 sub 更多
  };
}

// 树健康（繁茂度）→ 声部丰润度。枯萎 = 干瘪。
export function richnessFromFoliage(foliage) {
  const f = clamp(foliage);
  return {
    reverbSend: 0.06 + f * 0.5,    // 0.06（枯）→ 0.56（茂）
    harmonicGain: 0.25 + f * 0.75, // 高次谐波增益
  };
}

// 虫害程度 → 声部「杂质」。树病了听得出来。
export function impurityFromPest(pest) {
  const p = clamp(pest);
  return {
    noiseMix: p * 0.35,          // 噪声成分
    detuneCents: p * 35,         // 轻微失谐
  };
}

// 昼夜相位 → 滤波宏 + 密度上限。phase ∈ [0,1)：0.25=正午，0.75=午夜。
export function dayNightMacros(phase) {
  const t = ((phase % 1) + 1) % 1;
  // daylight：午夜(0.75) 0，正午(0.25) 1，余弦曲线。
  const day = clamp(0.5 + 0.5 * Math.cos((t - 0.25) * Math.PI * 2));
  return {
    filterMacro: 0.35 + day * 0.65,  // 全局亮度缩放
    densityCap: 0.25 + day * 0.75,   // 夜里允许的活跃上限
    daylight: day,
  };
}

// 全局健康（四树均值）→ 全局频段亮度 + lofi mix。
export function masterFromHealth(meanHealth) {
  const h = clamp(meanHealth);
  return {
    brightness: 0.45 + h * 0.55, // 全局 cutoff 缩放
    lofiMix: (1 - h) * 0.6,      // 枯萎 → lofi 加重
  };
}

// 镜头距离 → 混音焦点。focusFlock 为 null 时全平。
// 返回每个声部的增益；u=0 全景全平，u=1 近树前置、他树衰减。
export function mixFromCamera(u, focusFlockId, flockIds) {
  const t = clamp(u);
  return Object.fromEntries(flockIds.map((id) => {
    const gain = focusFlockId === null || focusFlockId === undefined
      ? 1
      : id === focusFlockId
        ? 1
        : 1 - t * 0.65; // 他树最多衰减到 0.35
    return [id, gain];
  }));
}

// 客音符标记：客鸟（非本树 flock）落枝时仍是 host 声部的音，但音色做轻微偏移，
// 让「串门」可辨。返回值是叠加在 host 音色上的 delta。
export function guestTimbreDelta() {
  return { detuneSpread: +18, filterCutoff: 1.22 }; // 更亮、略失谐
}
