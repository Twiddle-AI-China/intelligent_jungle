// mvp/src/audio.js —— 音频层。voice 路由完全由 trees[].species 与
// audio.timbres[species].polyphonic 驱动；音区只经 trees[].registerOffset 进入 mapping。
//
// v3 发声原理：pad=持续减法，bass=Karplus-Strong 拨弦琶音，melody=FM 短句，
// texture=granular 噪声簇。四者仍共用独立 EQ → 干声/混响发送 → 昼夜宏总线。
// 晨鸣机制已按产品裁定彻底摘除：dawn 只剩昼夜宏切换。

import { CONFIG } from './config.js';
import * as mapping from './mapping.js';

const SAT_CURVE_POINTS = 1024; // WaveShaper 曲线采样点数（实现常量，非调参）
const IMPULSE_SEED = 20260719; // 混响脉冲噪声种子（确定性生成，非调参）
const clamp = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));

// 确定性伪随机（mulberry32）：混响脉冲/噪声源用，可复现
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 从当前 transport 相位开始排到本昼夜末尾；beat 为昼夜内的绝对拍号，便于断言拍齐。
export function bassArpPlan({
  chordNotes, registerOffset = 0, skeletonBranches = 3, pattern = [0, 1, 2, 1],
  bpm = 60, phase = 0, barsPerDay = 4, beatsPerBar = 4, tension = 0,
  lowStepBeats = 1, highStepBeats = 0.5, tensionSplit = 0.55,
} = {}) {
  const pool = (Array.isArray(chordNotes) ? chordNotes : [])
    .slice(0, Math.max(1, skeletonBranches)).map((midi) => midi + registerOffset);
  if (!pool.length) return [];
  const stepBeats = clamp(Number(tension)) >= tensionSplit ? highStepBeats : lowStepBeats;
  const totalBeats = barsPerDay * beatsPerBar;
  const beatNow = clamp(Number(phase)) * totalBeats;
  const firstBeat = Math.ceil((beatNow - 1e-9) / stepBeats) * stepBeats;
  const secondsPerBeat = 60 / Math.max(1, Number(bpm) || 60);
  const result = [];
  for (let beat = firstBeat, i = 0; beat < totalBeats - 1e-9; beat += stepBeats, i += 1) {
    const poolIndex = pattern[i % pattern.length] ?? 0;
    result.push({
      beat,
      offsetSeconds: Math.max(0, beat - beatNow) * secondsPerBeat,
      midi: pool[((poolIndex % pool.length) + pool.length) % pool.length],
    });
  }
  return result;
}

// 框架内音级单向级进至目标枝音；目标永远是最后一音，一次落枝只生成一句。
export function melodyPhrasePlan({ targetMidi, chordNotes, minNotes = 2, maxNotes = 4, seed = 1,
  minSeconds = 0.1, maxSeconds = 0.25 } = {}) {
  const pool = [...new Set((Array.isArray(chordNotes) ? chordNotes : []).filter(Number.isFinite))]
    .sort((a, b) => a - b);
  if (!pool.length || !Number.isFinite(targetMidi)) return [];
  const targetIndex = pool.reduce((best, midi, index) => (
    Math.abs(midi - targetMidi) < Math.abs(pool[best] - targetMidi) ? index : best), 0);
  const requested = Math.max(minNotes, Math.min(maxNotes, minNotes + (Math.abs(seed) % (maxNotes - minNotes + 1))));
  const below = targetIndex;
  const above = pool.length - targetIndex - 1;
  const descend = above > below || (above === below && Math.abs(seed) % 2 === 1);
  const available = (descend ? above : below) + 1;
  const count = Math.max(1, Math.min(requested, available));
  const start = descend ? targetIndex + count - 1 : targetIndex - count + 1;
  const direction = descend ? -1 : 1;
  const rand = mulberry32((Math.abs(seed) || 1) + IMPULSE_SEED);
  let offsetSeconds = 0;
  return Array.from({ length: count }, (_, index) => {
    const durationSeconds = minSeconds + rand() * (maxSeconds - minSeconds);
    const note = { midi: pool[start + direction * index], offsetSeconds, durationSeconds };
    offsetSeconds += durationSeconds;
    return note;
  });
}

export function granularPlan({ tension = 0, seed = 1, countRange = [5, 12],
  secondsRange = [0.01, 0.04], gapRange = [0.02, 0.12], bandRange = [2500, 6000] } = {}) {
  const raw = Number(tension);
  const t = Number.isFinite(raw) ? clamp(raw) : 0;
  const count = Math.round(countRange[0] + t * (countRange[1] - countRange[0]));
  const rand = mulberry32((Math.abs(seed) || 1) + IMPULSE_SEED * 2);
  const center = (bandRange[0] + bandRange[1]) / 2;
  const halfSpan = (bandRange[1] - bandRange[0]) / 2 * (0.35 + 0.65 * t);
  let offsetSeconds = 0;
  return Array.from({ length: count }, (_, index) => {
    if (index > 0) offsetSeconds += gapRange[0]
      + rand() * (gapRange[1] - gapRange[0]) * (0.35 + 0.65 * t);
    return {
      offsetSeconds,
      durationSeconds: secondsRange[0] + rand() * (secondsRange[1] - secondsRange[0]),
      centerHz: center + (rand() * 2 - 1) * halfSpan,
    };
  });
}

export function createAudioEngine({ config = CONFIG, getChord, getFrame = () => null } = {}) {
  const cfg = config;
  let ctx = null;
  let master = null;
  let filter = null;   // 全局低通：昼夜宏（夜里闷、白天亮）
  let reverb = null;   // 共用混响总线（干湿分离：各声部按 reverbSend 发送）
  let noiseBuffer = null; // KS 激励与 texture 粒子共用的原生噪声 buffer
  const satCurveCache = new Map(); // drive -> Float32Array
  const sustainedVoices = new Map(); // birdId -> { species, oscillators, gain, dispose }
  const triggeredVoices = new Map(); // species -> [{ osc, gain, dispose }]
  const perchedBySpecies = new Map(); // 声部 -> Set<birdId>，bass arp 的开关/力度来源
  let granularSeed = 0;
  let attachedWorld = null;
  const treeRegister = Object.fromEntries(cfg.trees.map((tree) => [tree.id, tree.registerOffset ?? 0]));
  const treeSpecies = Object.fromEntries(cfg.trees.map((tree) => [tree.id, tree.species]));

  function makeImpulseResponse() {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * cfg.audio.reverb.seconds));
    const buffer = ctx.createBuffer(2, length, rate);
    const rand = mulberry32(IMPULSE_SEED);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        data[i] = (rand() * 2 - 1) * (1 - i / length) ** cfg.audio.reverb.decayExp;
      }
    }
    return buffer;
  }

  function makeNoiseBuffer() {
    const rate = ctx.sampleRate;
    const textureMax = cfg.audio.timbres.texture.grainSeconds?.[1] ?? 0.04;
    const bassBurst = cfg.audio.timbres.bass.excitationSeconds ?? 0.012;
    const length = Math.max(1, Math.floor(rate * Math.max(textureMax, bassBurst)));
    const buffer = ctx.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    const rand = mulberry32(IMPULSE_SEED + 1);
    for (let i = 0; i < length; i += 1) data[i] = rand() * 2 - 1;
    return buffer;
  }

  async function start() {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = cfg.audio.masterGain;
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cfg.audio.filterBaseHz;
      filter.Q.value = cfg.audio.filterQ;
      filter.connect(master);
      master.connect(ctx.destination);
      reverb = ctx.createConvolver();
      reverb.buffer = makeImpulseResponse();
      reverb.connect(filter); // 混响返回同过昼夜宏滤波（夜里混响也闷，保持世界观一致）
      noiseBuffer = makeNoiseBuffer();
    }
    await ctx.resume();
    if (attachedWorld && (perchedBySpecies.get('bass')?.size ?? 0) > 0) scheduleBassArp(attachedWorld);
  }

  function applyDaylight(daylight) {
    if (!ctx) return;
    const macros = mapping.dayNightAudioMacros(daylight, cfg.audio);
    filter.frequency.setTargetAtTime(macros.filterCutoffHz, ctx.currentTime, 0.5);
    master.gain.setTargetAtTime(cfg.audio.masterGain * macros.gainScale, ctx.currentTime, 0.5);
  }

  function saturationCurve(drive) {
    if (!satCurveCache.has(drive)) {
      const curve = new Float32Array(SAT_CURVE_POINTS);
      const norm = Math.tanh(drive);
      for (let i = 0; i < SAT_CURVE_POINTS; i += 1) {
        const x = (i / (SAT_CURVE_POINTS - 1)) * 2 - 1;
        curve[i] = Math.tanh(drive * x) / norm;
      }
      satCurveCache.set(drive, curve);
    }
    return satCurveCache.get(drive);
  }

  // 声部效果链：envGain → EQ 组 → 可选饱和 → 干声；并联混响发送与可选延迟。
  // 返回 dispose()：声部终结后断开整条链，避免节点在图上累积。
  function connectTimbre(gain, timbre) {
    const nodes = [gain];
    let tail = gain;
    const link = (node) => { tail.connect(node); nodes.push(node); tail = node; };
    for (const eqDef of timbre.eq ?? []) {
      const eq = ctx.createBiquadFilter();
      eq.type = eqDef.type;
      eq.frequency.value = eqDef.frequency;
      if (eqDef.Q !== undefined) eq.Q.value = eqDef.Q;
      if (eqDef.gain !== undefined) eq.gain.value = eqDef.gain;
      link(eq);
    }
    if ((timbre.saturation ?? 0) > 0) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = saturationCurve(timbre.saturation);
      shaper.oversample = cfg.audio.saturationOversample;
      link(shaper);
    }
    tail.connect(filter); // 干声
    if ((timbre.reverbSend ?? 0) > 0 && reverb) {
      const send = ctx.createGain();
      send.gain.value = timbre.reverbSend;
      tail.connect(send);
      send.connect(reverb);
      nodes.push(send);
    }
    let delayTailSeconds = 0;
    if (timbre.delay) {
      const delayNode = ctx.createDelay(timbre.delay.timeSeconds);
      delayNode.delayTime.value = timbre.delay.timeSeconds;
      const feedback = ctx.createGain();
      feedback.gain.value = timbre.delay.feedback;
      const mix = ctx.createGain();
      mix.gain.value = timbre.delay.mix;
      tail.connect(delayNode);
      delayNode.connect(feedback);
      feedback.connect(delayNode);
      delayNode.connect(mix);
      mix.connect(filter);
      nodes.push(delayNode, feedback, mix);
      // 回声降到 -60dB 所需时长：repeats = ln(0.001)/ln(feedback)
      delayTailSeconds = timbre.delay.timeSeconds
        * (Math.log(0.001) / Math.log(Math.max(timbre.delay.feedback, 0.01)));
    }
    return {
      delayTailSeconds,
      dispose() { for (const node of nodes) { try { node.disconnect(); } catch { /* 已断开 */ } } },
    };
  }

  function stopSustainedVoice(birdId, immediate = false) {
    const voice = sustainedVoices.get(birdId);
    if (!voice) return;
    sustainedVoices.delete(birdId);
    const timbre = cfg.audio.timbres[voice.species];
    const t = ctx.currentTime;
    const release = immediate ? 0.01 : timbre.releaseSeconds;
    voice.gain.gain.cancelScheduledValues(t);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, t);
    voice.gain.gain.linearRampToValueAtTime(0, t + release);
    for (const osc of voice.oscillators) osc.stop(t + release + 0.05);
    setTimeout(() => voice.dispose(), (release + 0.1) * 1000);
  }

  function startSustainedVoice(species, birdId, { midi, velocity }) {
    const timbre = cfg.audio.timbres[species];
    stopSustainedVoice(birdId, true);
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(velocity * timbre.sustainLevel, t + timbre.attackSeconds);
    const { dispose } = connectTimbre(gain, timbre);

    const main = ctx.createOscillator();
    main.type = timbre.oscType;
    main.frequency.value = mapping.midiToFrequency(midi);
    main.connect(gain);
    const oscillators = [main];
    if ((timbre.detuneCents ?? 0) > 0) { // 柔和叠加：第二 osc 轻失谐
      const det = ctx.createOscillator();
      det.type = timbre.oscType;
      det.frequency.value = mapping.midiToFrequency(midi);
      det.detune.value = timbre.detuneCents;
      const detGain = ctx.createGain();
      detGain.gain.value = timbre.detuneMix;
      det.connect(detGain);
      detGain.connect(gain);
      oscillators.push(det);
    }
    if (timbre.subOscMix > 0) {
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = mapping.midiToFrequency(midi - 12);
      const subGain = ctx.createGain();
      subGain.gain.value = timbre.subOscMix;
      sub.connect(subGain);
      subGain.connect(gain);
      oscillators.push(sub);
    }
    for (const osc of oscillators) osc.start(t);
    sustainedVoices.set(birdId, { species, oscillators, gain, dispose });
  }

  function silenceTriggered(species) {
    const voices = triggeredVoices.get(species) ?? [];
    const t = ctx.currentTime;
    for (const voice of voices) {
      voice.gain.gain.cancelScheduledValues(t);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, t);
      voice.gain.gain.linearRampToValueAtTime(0, t + 0.03);
      for (const source of voice.sources ?? []) {
        try { source.stop(t + 0.08); } catch { /* already stopped */ }
      }
      voice.dispose(); // 单音顶旧音：旧链连同延迟尾一起撤
    }
    triggeredVoices.delete(species);
  }

  // 未声明 v3 engine 的兼容触发音色；现有四物种只由下方三种专用引擎消费。
  function triggerVoice(species, { midi, velocity, durationSeconds }) {
    const timbre = cfg.audio.timbres[species];
    silenceTriggered(species); // polyphonic=false：同物种新触发让旧触发让位
    const repeats = Math.max(1, Math.floor(timbre.repeatCount ?? 1));
    const interval = Math.max(0, timbre.repeatIntervalSeconds ?? 0);
    const duration = Math.max(0.01, timbre.noteSeconds ?? durationSeconds ?? timbre.releaseSeconds);
    const voices = [];
    for (let index = 0; index < repeats; index += 1) {
      const t = ctx.currentTime + index * interval;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(velocity * timbre.sustainLevel, t + timbre.attackSeconds);
      gain.gain.exponentialRampToValueAtTime(0.001, t + timbre.attackSeconds + duration);
      const { dispose, delayTailSeconds } = connectTimbre(gain, timbre);
      const osc = ctx.createOscillator();
      osc.type = timbre.oscType;
      osc.frequency.value = mapping.midiToFrequency(midi);
      if ((timbre.noiseMix ?? 0) > 0) { // 敲击：噪声瞬态为主 + osc 留一点音高暗示
        const oscGain = ctx.createGain();
        oscGain.gain.value = 1 - timbre.noiseMix;
        osc.connect(oscGain);
        oscGain.connect(gain);
        const noise = ctx.createBufferSource();
        noise.buffer = noiseBuffer;
        const noiseGain = ctx.createGain();
        noiseGain.gain.value = timbre.noiseMix;
        noise.connect(noiseGain);
        noiseGain.connect(gain);
        noise.start(t);
        noise.stop(t + timbre.attackSeconds + duration + 0.05);
      } else {
        osc.connect(gain);
      }
      osc.start(t);
      osc.stop(t + timbre.attackSeconds + duration + 0.05);
      // 自然结束后按延迟尾时长断开链（回声落尽再撤节点）
      osc.onended = () => setTimeout(dispose, (delayTailSeconds + 0.1) * 1000);
      voices.push({ sources: [osc], gain, dispose });
    }
    triggeredVoices.set(species, voices);
  }

  function currentTension() {
    const value = Number(getFrame?.()?.tension);
    return Number.isFinite(value) ? clamp(value) : 0;
  }

  // 一次安排到当前昼夜末；黎明若仍有 bass 栖鸟会重排下一循环。
  function scheduleBassArp(world) {
    const species = 'bass';
    const timbre = cfg.audio.timbres[species];
    const perchedCount = perchedBySpecies.get(species)?.size ?? 0;
    if (!perchedCount) { silenceTriggered(species); return; }
    silenceTriggered(species);
    const snapshot = world.getSnapshot();
    const plan = bassArpPlan({
      chordNotes: getChord()?.notes,
      registerOffset: treeRegister.bass ?? -12,
      skeletonBranches: cfg.harmony.skeletonBranches,
      pattern: timbre.arpPattern,
      bpm: snapshot.bpm ?? cfg.tempo.defaultBpm,
      phase: snapshot.phase ?? 0,
      barsPerDay: cfg.tempo.barsPerDay,
      beatsPerBar: cfg.tempo.beatsPerBar,
      tension: currentTension(),
      lowStepBeats: timbre.lowTensionStepBeats,
      highStepBeats: timbre.highTensionStepBeats,
      tensionSplit: timbre.tensionDensitySplit,
    });
    if (!plan.length) return;

    const bus = ctx.createGain();
    bus.gain.value = timbre.sustainLevel * Math.min(1, 0.7 + perchedCount * 0.15);
    const { dispose } = connectTimbre(bus, timbre);
    const sources = [];
    for (const note of plan) {
      const at = ctx.currentTime + note.offsetSeconds;
      const frequency = mapping.midiToFrequency(note.midi);
      const excitation = ctx.createBufferSource();
      excitation.buffer = noiseBuffer;
      const burst = ctx.createGain();
      burst.gain.setValueAtTime(1, at);
      burst.gain.exponentialRampToValueAtTime(0.001, at + timbre.excitationSeconds);
      const stringDelay = ctx.createDelay(1);
      stringDelay.delayTime.value = 1 / frequency;
      const damping = ctx.createBiquadFilter();
      damping.type = 'lowpass';
      damping.frequency.value = Math.min(timbre.dampingHz, frequency * 3.5);
      damping.Q.value = 0.35;
      const feedback = ctx.createGain();
      feedback.gain.setValueAtTime(timbre.feedback, at);
      // 明确杀掉每根虚拟弦的反馈尾，避免跨拍/跨昼夜的环叠加污染全局滤波状态。
      feedback.gain.exponentialRampToValueAtTime(0.001, at + timbre.noteDecaySeconds);
      const noteGain = ctx.createGain();
      noteGain.gain.setValueAtTime(1, at);
      noteGain.gain.exponentialRampToValueAtTime(0.001, at + timbre.noteDecaySeconds);

      excitation.connect(burst);
      burst.connect(stringDelay);
      stringDelay.connect(damping);
      damping.connect(feedback);
      feedback.connect(stringDelay); // KS feedback loop：delay → lowpass → gain → delay
      stringDelay.connect(noteGain);
      noteGain.connect(bus);
      excitation.start(at);
      excitation.stop(at + timbre.excitationSeconds);
      sources.push(excitation);
    }
    triggeredVoices.set(species, [{ sources, gain: bus, dispose }]);
  }

  function triggerFmPhrase(event, note) {
    const species = 'melody';
    const timbre = cfg.audio.timbres[species];
    silenceTriggered(species);
    const registerOffset = treeRegister[event.treeId] ?? 0;
    const chordNotes = (getChord()?.notes ?? []).map((midi) => midi + registerOffset);
    const phrase = melodyPhrasePlan({
      targetMidi: note.midi,
      chordNotes,
      minNotes: timbre.phraseMinNotes,
      maxNotes: timbre.phraseMaxNotes,
      seed: Number(event.birdId) + Number(event.branchId) * 17,
      minSeconds: timbre.noteMinSeconds,
      maxSeconds: timbre.noteMaxSeconds,
    });
    if (!phrase.length) return;
    const bus = ctx.createGain();
    bus.gain.value = note.velocity * timbre.sustainLevel;
    const { dispose } = connectTimbre(bus, timbre);
    const sources = [];
    for (const phraseNote of phrase) {
      const at = ctx.currentTime + phraseNote.offsetSeconds;
      const duration = phraseNote.durationSeconds;
      const frequency = mapping.midiToFrequency(phraseNote.midi + timbre.outputOctave);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.001, at);
      env.gain.linearRampToValueAtTime(1, at + timbre.attackSeconds);
      env.gain.exponentialRampToValueAtTime(0.001, at + duration + timbre.releaseSeconds);
      env.connect(bus);

      const carrier = ctx.createOscillator();
      carrier.type = timbre.carrierType;
      carrier.frequency.value = frequency;
      carrier.connect(env);
      const modulator = ctx.createOscillator();
      modulator.type = timbre.modulatorType;
      modulator.frequency.value = frequency * timbre.fmRatio;
      const index = ctx.createGain();
      index.gain.setValueAtTime(frequency * timbre.fmIndex, at);
      index.gain.exponentialRampToValueAtTime(0.001, at + timbre.fmIndexDecaySeconds);
      modulator.connect(index);
      index.connect(carrier.frequency);

      const vibrato = ctx.createOscillator();
      vibrato.type = 'sine';
      vibrato.frequency.value = timbre.vibratoHz;
      const vibratoDepth = ctx.createGain();
      vibratoDepth.gain.setValueAtTime(0, at);
      vibratoDepth.gain.linearRampToValueAtTime(timbre.vibratoCents, at + duration * 0.55);
      vibrato.connect(vibratoDepth);
      vibratoDepth.connect(carrier.detune);

      for (const source of [carrier, modulator, vibrato]) {
        source.start(at);
        source.stop(at + duration + timbre.releaseSeconds + 0.02);
        sources.push(source);
      }
    }
    triggeredVoices.set(species, [{ sources, gain: bus, dispose }]);
  }

  function triggerGranular(event, note) {
    const species = 'texture';
    const timbre = cfg.audio.timbres[species];
    silenceTriggered(species);
    granularSeed += 1;
    const plan = granularPlan({
      tension: currentTension(),
      seed: granularSeed + Number(event.birdId) * 31,
      countRange: timbre.grainCount,
      secondsRange: timbre.grainSeconds,
      gapRange: timbre.grainGapSeconds,
      bandRange: timbre.grainBandHz,
    });
    const bus = ctx.createGain();
    bus.gain.value = note.velocity * timbre.sustainLevel;
    const { dispose } = connectTimbre(bus, timbre);
    const sources = [];
    for (const grain of plan) {
      const at = ctx.currentTime + grain.offsetSeconds;
      const source = ctx.createBufferSource();
      source.buffer = noiseBuffer;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = grain.centerHz;
      band.Q.value = timbre.grainQ;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.001, at);
      env.gain.linearRampToValueAtTime(1, at + Math.min(0.004, grain.durationSeconds / 3));
      env.gain.exponentialRampToValueAtTime(0.001, at + grain.durationSeconds);
      source.connect(band);
      band.connect(env);
      env.connect(bus);
      source.start(at);
      source.stop(at + grain.durationSeconds);
      sources.push(source);
    }
    triggeredVoices.set(species, [{ sources, gain: bus, dispose }]);
  }

  function attach(world) {
    attachedWorld = world;
    // setTempo 后重排 bass arp：已挂 AudioParam 时刻按旧 BPM 算的 offset 会相对新拍网格漂移。
    const originalSetTempo = typeof world.setTempo === 'function'
      ? world.setTempo.bind(world) : null;
    if (originalSetTempo) {
      world.setTempo = (bpm) => {
        const ok = originalSetTempo(bpm);
        if (ok && ctx && (perchedBySpecies.get('bass')?.size ?? 0) > 0) {
          scheduleBassArp(world);
        }
        return ok;
      };
    }
    world.on('perch', (event) => {
      const species = treeSpecies[event.treeId];
      const timbre = cfg.audio.timbres[species];
      if (!timbre) return;
      if (!perchedBySpecies.has(species)) perchedBySpecies.set(species, new Set());
      const perched = perchedBySpecies.get(species);
      const wasEmpty = perched.size === 0;
      perched.add(event.birdId);
      if (!ctx) return;
      applyDaylight(world.getSnapshot().daylight);
      const note = mapping.perchToNote(event, getChord(), cfg, treeRegister[event.treeId] ?? 0);
      if (timbre.engine === 'karplusArp') {
        if (wasEmpty) scheduleBassArp(world);
      } else if (timbre.engine === 'fmPhrase') {
        triggerFmPhrase(event, note);
      } else if (timbre.engine === 'granular') {
        triggerGranular(event, note);
      } else if (timbre.polyphonic) {
        startSustainedVoice(species, event.birdId, note);
      } else {
        triggerVoice(species, { ...note, durationSeconds: timbre.releaseSeconds });
      }
    });
    world.on('unperch', (event) => {
      const species = treeSpecies[event.treeId];
      const timbre = cfg.audio.timbres[species];
      perchedBySpecies.get(species)?.delete(event.birdId);
      if (!ctx) return;
      if (timbre?.engine === 'karplusArp') {
        if ((perchedBySpecies.get(species)?.size ?? 0) === 0) silenceTriggered(species);
        return;
      }
      if (!timbre?.polyphonic) return; // 触发型音色自然衰减
      mapping.unperchToRelease(event, getChord(), cfg, treeRegister[event.treeId] ?? 0);
      stopSustainedVoice(event.birdId);
    });
    world.on('dawn', () => {
      if (!ctx) return;
      applyDaylight(world.getSnapshot().daylight); // 晨鸣已摘除：黎明只剩昼夜宏切换
      if ((perchedBySpecies.get('bass')?.size ?? 0) > 0) scheduleBassArp(world);
    });
  }

  function describeVoices() {
    return Object.fromEntries(Object.entries(cfg.audio.timbres).map(([species, timbre]) => [species, { ...timbre }]));
  }

  function getRecordingTap() {
    return ctx && master ? { audioContext: ctx, sourceNode: master } : null;
  }

  return { start, attach, describeVoices, getRecordingTap, isRunning: () => !!ctx && ctx.state === 'running' };
}
