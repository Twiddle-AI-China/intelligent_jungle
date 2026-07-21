// mvp/src/audio.js —— 音频层。voice 路由完全由 trees[].species 与
// audio.timbres[species].polyphonic 驱动；音区只经 trees[].registerOffset 进入 mapping。
//
// 发声原理（T43 选定音色）：pad=additive sine 泛音簇持续音，bass=本枝三角波软脉冲，
// melody=正弦鸟鸣哨音短句（颤音+滑音），texture=granular 噪声簇。
// 四者仍共用独立 EQ → 干声/混响发送 → 昼夜宏总线。
// 晨鸣机制已按产品裁定彻底摘除：dawn 只剩昼夜宏切换。

import { CONFIG } from './config.js';
import * as mapping from './mapping.js';

const SAT_CURVE_POINTS = 1024; // WaveShaper 曲线采样点数（实现常量，非调参）
const IMPULSE_SEED = 20260719; // 混响脉冲噪声种子（确定性生成，非调参）
const LEVEL_SAMPLE_MS = 100; // 只观测：声部 RMS/峰值采样，不进 economy score
const clamp = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));

// R3 特写调节：通用 + 声部特有。UI/测试共用此清单（名称/范围/映射）。
export const MIX_PARAM_SPECS = Object.freeze({
  common: Object.freeze([
    Object.freeze({ key: 'gain', label: '响度', min: 0, max: 2, step: 0.01, node: 'bus.gain' }),
    Object.freeze({ key: 'eqLowDb', label: 'EQ低', min: -12, max: 12, step: 0.5, node: 'bus.lowShelf' }),
    Object.freeze({ key: 'eqMidDb', label: 'EQ中', min: -12, max: 12, step: 0.5, node: 'bus.midPeak' }),
    Object.freeze({ key: 'eqHighDb', label: 'EQ高', min: -12, max: 12, step: 0.5, node: 'bus.highShelf' }),
    Object.freeze({ key: 'reverbSend', label: '混响', min: 0, max: 1, step: 0.01, node: 'bus.send' }),
  ]),
  pad: Object.freeze([
    Object.freeze({ key: 'attackSeconds', label: '起音', min: 0.05, max: 1.5, step: 0.01, node: 'timbre.attackSeconds' }),
  ]),
  melody: Object.freeze([
    Object.freeze({ key: 'phraseMaxNotes', label: '句长', min: 2, max: 8, step: 1, node: 'timbre.phraseMaxNotes' }),
  ]),
  bass: Object.freeze([
    Object.freeze({ key: 'pulseDensityMax', label: '脉冲密度', min: 0, max: 1, step: 0.01, node: 'timbre.pulseDensityMax→stepBeats' }),
  ]),
  texture: Object.freeze([
    Object.freeze({ key: 'grainCountMax', label: '粒数上限', min: 3, max: 20, step: 1, node: 'timbre.grainCountMax' }),
  ]),
});

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

// 单只鹈鹕从当前 transport 相位起，按张力安排自己的本枝音到本昼夜末尾。
// beat 是昼夜内绝对拍号；这里只改变重复速率，不从独立音池挑音。
export function bassPulsePlan({
  midi,
  bpm = 60, phase = 0, barsPerDay = 4, beatsPerBar = 4, tension = 0,
  lowStepBeats = 1, highStepBeats = 0.5, tensionSplit = 0.55,
} = {}) {
  if (!Number.isFinite(midi)) return [];
  const stepBeats = clamp(Number(tension)) >= tensionSplit ? highStepBeats : lowStepBeats;
  const totalBeats = barsPerDay * beatsPerBar;
  const beatNow = clamp(Number(phase)) * totalBeats;
  const firstBeat = Math.ceil((beatNow - 1e-9) / stepBeats) * stepBeats;
  const secondsPerBeat = 60 / Math.max(1, Number(bpm) || 60);
  const result = [];
  for (let beat = firstBeat; beat < totalBeats - 1e-9; beat += stepBeats) {
    result.push({
      beat,
      offsetSeconds: Math.max(0, beat - beatNow) * secondsPerBeat,
      midi,
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
  // ---- 神经音源桥（flock-voice-engine，v2 brave-voices）------------------------
  // 只接管 cfg.voiceEngine.species 里列出的物种（见 config.js 顶部注释：
  // bass/pad/melody 默认接管，texture 留在本地——backend 那颗 checkpoint 还没练）。
  //
  // 分轨连接（split:1）：后端每条 voice 池行各出一路干声。默认这路会自动汇入
  // client.output 直通 destination（voice-client.js 自己的兜底行为，保证「什么
  // 都不接也能出声」）；这里改成断开默认汇流、接进该物种自己的
  // ensureSpeciesBus(...).input —— 神经声部因此也走本地 EQ / mute / solo / 混响
  // 发送这条链，跟本地合成的其余声部同等对待，不是绕过 mixing 直接怼 destination。
  //
  // bass / melody 在这份合成器里不是"一个事件一个音"，是各自生成一整段节奏型
  // / 乐句 plan（bassPulsePlan / melodyPhrasePlan）按 Web Audio 采样级时钟精确
  // 排布的。WS 桥没有那个时钟，只能退而求其次用 setTimeout 在每个音符的
  // offsetSeconds 上发一条 note——时序精度是"听感上过得去"，不是采样级，是刻意
  // 的简化，不是 bug（真要做到采样级要在服务端加音符序列接口，这轮不做）。
  //
  // pad 是聚合多只栖鸟的和弦（refreshPadVoicing），但后端 voice 池每行逐行单音
  // /最后一音优先（protocol.md §6），带不走整个和弦。这里的取舍是"神经只带走
  // 和弦里最新落位的那一个音"：新 pad 鸟落位就抢占神经行（hold，见 protocol.md
  // §8.6 的无上限延音语义，天然贴合"栖鸟不知道自己会站多久"），旧和弦音仍留在
  // 本地 sustained 引擎里正常发声——两边同时响，不是谁替代谁，出来的是"和弦垫底
  // + 神经音色领奏"，跟纯本地和弦不是一回事，这是已知、明说的简化。
  const veCfg = cfg.voiceEngine ?? { enabled: false, species: {} };
  const neural = {
    client: null,
    connected: false,
    wired: false,
    neuralPadBirdId: null,
    scheduled: new Map(), // species -> [timeoutId,...]，打断旧 plan 时清空未触发的定时器
    owns(species) {
      return !!(veCfg.enabled && this.connected && veCfg.species?.[species]);
    },
    async connect() {
      if (!veCfg.enabled || this.client) return;
      const factory = globalThis.FlockVoiceClient;
      if (!factory?.create) {
        console.warn('[voice-engine] voice-client.js 未加载，全部退回本地合成');
        return;
      }
      try {
        this.client = factory.create({ context: ctx, split: true, poolSize: 4 });
        this.client.onStateChange((state) => {
          this.connected = state.mode === 'streaming';
          if (this.connected) this.wireTracks();
        });
        const url = veCfg.url
          || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/decoder`;
        await this.client.connect(url);
      } catch (error) {
        console.warn('[voice-engine] 连接失败，退回本地合成:', error?.message ?? error);
        this.connected = false;
      }
    },
    // 分轨出口重接线：每次连上（含重连）都可能拿到新节点，重复调用是安全的
    // （disconnect 一个已断开的节点不会抛）。
    wireTracks() {
      if (!this.client?.isSplit) {
        console.warn('[voice-engine] 后端未开分轨，神经声部会绕过本地 EQ/mute/solo 直接出声');
        return;
      }
      for (const [species, spec] of Object.entries(veCfg.species ?? {})) {
        const track = this.client.trackOutput(spec.row);
        if (!track) continue;
        const bus = ensureSpeciesBus(species);
        try { track.disconnect(); } catch { /* 已断开 */ }
        track.connect(bus.input);
      }
      this.wired = true;
    },
    noteOn(species, midi, velocity, durationSeconds) {
      if (!this.client) return false;
      const row = veCfg.species?.[species]?.row;
      if (row === undefined) return false;
      try { this.client.noteWithDuration(row, midi, velocity, durationSeconds); return true; }
      catch { return false; }
    },
    holdNote(species, midi, velocity) {
      if (!this.client) return false;
      const row = veCfg.species?.[species]?.row;
      if (row === undefined) return false;
      try { this.client.hold(row, midi, velocity); return true; } catch { return false; }
    },
    releaseNote(species) {
      if (!this.client) return false;
      const row = veCfg.species?.[species]?.row;
      if (row === undefined) return false;
      try { this.client.release(row); return true; } catch { return false; }
    },
    // plan: [{offsetSeconds, midi, durationSeconds?}, ...]。见上方大注释——没有
    // 采样级时钟，用 setTimeout 逐个下发；空数组只是清掉上一轮还没触发的定时器。
    // 单个 plan note 没带 durationSeconds 时退回 defaultDurationSeconds
    // （bass 的 noteSeconds 是配置里的固定值，不是逐音符字段）。
    playPlan(species, plan, velocity, defaultDurationSeconds) {
      const old = this.scheduled.get(species);
      if (old) for (const id of old) clearTimeout(id);
      const ids = plan.map((note) => setTimeout(() => {
        this.noteOn(species, note.midi, velocity, note.durationSeconds ?? defaultDurationSeconds);
      }, Math.max(0, note.offsetSeconds * 1000)));
      this.scheduled.set(species, ids);
    },
    // 漫游：timbreXY/timbreK 是 v2 协议字段（protocol.md §8.5）。**不是** v1 的
    // 锚点索引 timbre 字段——那个字段对 brave-voices 已经不生效，写了也没反应。
    roamTo(species, xy, k) {
      if (!this.client) return false;
      const row = veCfg.species?.[species]?.row;
      if (row === undefined) return false;
      try { this.client.setParams(row, { timbreXY: xy, timbreK: k }); return true; }
      catch { return false; }
    },
  };
  let master = null;
  let filter = null;   // 全局低通：昼夜宏（夜里闷、白天亮）
  let reverb = null;   // 共用混响总线（干湿分离：各声部按 reverbSend 发送）
  let noiseBuffer = null; // texture 粒子共用的原生噪声 buffer
  const satCurveCache = new Map(); // drive -> Float32Array
  const sustainedVoices = new Map(); // birdId -> { species, midi, role, oscillators, gain, dispose }
  const triggeredVoices = new Map(); // species -> [{ osc, gain, dispose }]
  const perchedBySpecies = new Map(); // 声部 -> Set<birdId>，触发/持续音的存活集合
  const padPerches = new Map(); // birdId -> 最近 perch 事件；聚合后保持本枝音与黎明 voice-leading
  const bassPerches = new Map(); // birdId -> { event, midi }；每只鹈鹕只脉冲自己的低枝音
  let granularSeed = 0;
  let attachedWorld = null;
  const treeRegister = Object.fromEntries(cfg.trees.map((tree) => [tree.id, tree.registerOffset ?? 0]));
  const treeSpecies = Object.fromEntries(cfg.trees.map((tree) => [tree.id, tree.species]));
  // R3：每声部用户调节总线（gain/EQ/send）+ zoom 混响缩放；持久节点，voice dispose 不断开。
  const speciesBuses = new Map();
  const zoomReverbScale = Object.fromEntries(Object.keys(cfg.audio.timbres).map((s) => [s, 1]));
  // WS-2：播放层 mute/solo（不改 world/economy）；gate 在用户 gain 之后。
  const muteBySpecies = Object.fromEntries(Object.keys(cfg.audio.timbres).map((s) => [s, false]));
  const soloBySpecies = Object.fromEntries(Object.keys(cfg.audio.timbres).map((s) => [s, false]));
  // 日账：squareSum/sampleCount/dayPeak（黎明关账用）。
  // 实时表：liveRms 短窗替换、livePeak 每采样指数衰减——避免从不重置导致顶满/洗平。
  const LEVEL_PEAK_DECAY = 0.85;
  const levelAccumulators = new Map(); // species -> { squareSum, sampleCount, dayPeak, liveRms, livePeak }
  let levelTimer = null;

  function emptyLevelAcc() {
    return { squareSum: 0, sampleCount: 0, dayPeak: 0, liveRms: 0, livePeak: 0 };
  }

  function resetLevelAccumulators() {
    for (const species of Object.keys(cfg.audio.timbres)) {
      levelAccumulators.set(species, emptyLevelAcc());
    }
  }

  function sampleAudioLevels() {
    for (const [species, bus] of speciesBuses) {
      const analyser = bus.analyser;
      if (typeof analyser?.getFloatTimeDomainData !== 'function') continue;
      const samples = new Float32Array(analyser.fftSize || 256);
      analyser.getFloatTimeDomainData(samples);
      const acc = levelAccumulators.get(species) ?? emptyLevelAcc();
      let windowSum = 0;
      let windowPeak = 0;
      for (const sample of samples) {
        windowSum += sample * sample;
        windowPeak = Math.max(windowPeak, Math.abs(sample));
        acc.squareSum += sample * sample;
        acc.sampleCount += 1;
        acc.dayPeak = Math.max(acc.dayPeak, Math.abs(sample));
      }
      const instantRms = samples.length ? Math.sqrt(windowSum / samples.length) : 0;
      // 短窗 RMS：本缓冲瞬时值（读表方每帧 sample 即见起落）
      acc.liveRms = instantRms;
      acc.livePeak = Math.max((acc.livePeak ?? 0) * LEVEL_PEAK_DECAY, windowPeak);
      levelAccumulators.set(species, acc);
    }
  }

  function audioLevelSnapshot() {
    return Object.fromEntries(Object.keys(cfg.audio.timbres).map((species) => {
      const acc = levelAccumulators.get(species) ?? emptyLevelAcc();
      return [species, {
        rms: acc.liveRms,
        peak: acc.livePeak,
        samples: acc.sampleCount,
      }];
    }));
  }

  function getAudioLevels({ sample = true, reset = false } = {}) {
    if (sample) sampleAudioLevels();
    const levels = audioLevelSnapshot();
    if (reset) resetLevelAccumulators();
    return levels;
  }

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
    const length = Math.max(1, Math.floor(rate * textureMax));
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
      resetLevelAccumulators();
      for (const species of Object.keys(cfg.audio.timbres)) ensureSpeciesBus(species);
      levelTimer = setInterval(sampleAudioLevels, LEVEL_SAMPLE_MS);
      levelTimer.unref?.();
    }
    await ctx.resume();
    // 连神经音源。必须在用户手势之后（和 AudioContext 同一时机），且不阻塞
    // 世界启动——连不上就退回本地合成，前端不因后端缺席而哑掉。
    neural.connect().catch(() => {});
    if (padPerches.size > 0) refreshPadVoicing();
    if (attachedWorld && bassPerches.size > 0) scheduleBassPulses(attachedWorld);
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

  function gateFactorFor(species) {
    if (muteBySpecies[species]) return 0;
    const anySolo = Object.values(soloBySpecies).some(Boolean);
    if (anySolo && !soloBySpecies[species]) return 0;
    return 1;
  }

  function refreshMuteSoloGates() {
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const species of Object.keys(cfg.audio.timbres)) {
      const bus = speciesBuses.get(species);
      if (!bus?.gate) continue;
      bus.gate.gain.setTargetAtTime(gateFactorFor(species), t, 0.02);
    }
  }

  // 声部效果链：envGain → 固定 EQ/饱和 → 声部总线(用户 gain → 搁架 EQ → mute/solo gate) → 昼夜宏。
  // analyser 在 gate 前并联旁路，mute/solo 不改 economy 日结电平。
  // dispose 只拆本 voice 节点，共享总线由引擎持有。
  function ensureSpeciesBus(species) {
    if (speciesBuses.has(species)) return speciesBuses.get(species);
    const timbre = cfg.audio.timbres[species] ?? {};
    const input = ctx.createGain();
    input.gain.value = 1;
    const gain = ctx.createGain();
    gain.gain.value = Number.isFinite(timbre.gain) ? timbre.gain : 1;
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 250;
    low.gain.value = timbre.eqLowDb ?? 0;
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1200;
    mid.Q.value = 0.7;
    mid.gain.value = timbre.eqMidDb ?? 0;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 4000;
    high.gain.value = timbre.eqHighDb ?? 0;
    const gate = ctx.createGain();
    gate.gain.value = gateFactorFor(species);
    const send = ctx.createGain();
    send.gain.value = (timbre.reverbSend ?? 0) * (zoomReverbScale[species] ?? 1);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    input.connect(gain);
    gain.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(gate);
    gate.connect(filter); // 干声主干经 mute/solo gate
    high.connect(analyser); // 并联旁路 tap（gate 前）；Analyser 不连任何下游
    if (reverb) {
      gate.connect(send);
      send.connect(reverb);
    }
    const bus = { input, gain, gate, low, mid, high, send, analyser };
    speciesBuses.set(species, bus);
    return bus;
  }

  function refreshBusSend(species) {
    const bus = speciesBuses.get(species);
    if (!bus || !ctx) return;
    const timbre = cfg.audio.timbres[species] ?? {};
    const amount = (timbre.reverbSend ?? 0) * (zoomReverbScale[species] ?? 1);
    bus.send.gain.setTargetAtTime(amount, ctx.currentTime, 0.03);
  }

  function connectTimbre(gain, timbre, species) {
    const nodes = [gain];
    const modulators = [];
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
    const bus = ensureSpeciesBus(species);
    tail.connect(bus.input);
    if (timbre.chorus) {
      const delays = timbre.chorus.delaySeconds ?? [0.012, 0.019];
      for (let index = 0; index < delays.length; index += 1) {
        const delay = ctx.createDelay(Math.max(...delays) + (timbre.chorus.depthSeconds ?? 0));
        delay.delayTime.value = delays[index];
        const wet = ctx.createGain();
        wet.gain.value = (timbre.chorus.mix ?? 0.15) / delays.length;
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = (timbre.chorus.rateHz ?? 0.15) * (1 + index * 0.07);
        const depth = ctx.createGain();
        depth.gain.value = (index % 2 ? -1 : 1) * (timbre.chorus.depthSeconds ?? 0.002);
        lfo.connect(depth);
        depth.connect(delay.delayTime);
        tail.connect(delay);
        delay.connect(wet);
        wet.connect(bus.input);
        lfo.start(ctx.currentTime);
        nodes.push(delay, wet, lfo, depth);
        modulators.push(lfo);
      }
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
      mix.connect(bus.input);
      nodes.push(delayNode, feedback, mix);
      delayTailSeconds = timbre.delay.timeSeconds
        * (Math.log(0.001) / Math.log(Math.max(timbre.delay.feedback, 0.01)));
    }
    return {
      delayTailSeconds,
      dispose() {
        for (const source of modulators) { try { source.stop(); } catch { /* 已停止 */ } }
        for (const node of nodes) { try { node.disconnect(); } catch { /* 已断开 */ } }
      },
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

  function startSustainedVoice(species, birdId, { midi, velocity, role = null }, revoice = false) {
    const timbre = cfg.audio.timbres[species];
    const current = sustainedVoices.get(birdId);
    if (current?.midi === midi) {
      current.role = role; // 成员数变化可换角色但恰逢同音；仍更新身份供下一帧稳定延续。
      return;
    }
    stopSustainedVoice(birdId, !revoice);
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    const target = velocity * timbre.sustainLevel;
    gain.gain.linearRampToValueAtTime(target, t + timbre.attackSeconds);
    // additive sine 泛音簇：每泛音再作微失谐三重奏，持音仍有拍频与宽度。
    const base = mapping.midiToFrequency(midi);
    const oscillators = [];
    const toneOscillators = [];
    const extraNodes = [];
    const detunes = timbre.detuneCents ?? [0];
    for (const [ratio, level] of timbre.partials ?? [[1, 1]]) {
      for (const cents of detunes) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = base * ratio;
        osc.detune.value = cents;
        const partialGain = ctx.createGain();
        partialGain.gain.value = level / detunes.length;
        osc.connect(partialGain);
        partialGain.connect(gain);
        oscillators.push(osc);
        toneOscillators.push(osc);
        extraNodes.push(partialGain);
      }
    }
    if ((timbre.breatheDepth ?? 0) > 0) { // 呼吸调幅：慢 LFO 按目标电平比例轻推音量
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = timbre.breatheHz;
      const depth = ctx.createGain();
      depth.gain.value = timbre.breatheDepth * target;
      lfo.connect(depth);
      depth.connect(gain.gain);
      oscillators.push(lfo);
      extraNodes.push(depth);
    }
    // D1 pad：缓慢音色调制——滤波截止扫 + 微失谐漂移（不改 midi/voicing）。
    let voiceOut = gain;
    if (species === 'pad' && (timbre.filterModHz ?? 0) > 0) {
      const sweep = ctx.createBiquadFilter();
      sweep.type = 'lowpass';
      sweep.frequency.value = timbre.filterModBaseHz ?? 1450;
      sweep.Q.value = timbre.filterModQ ?? 0.6;
      const filterLfo = ctx.createOscillator();
      filterLfo.type = 'sine';
      filterLfo.frequency.value = timbre.filterModHz;
      const filterDepth = ctx.createGain();
      filterDepth.gain.value = timbre.filterModDepthHz ?? 380;
      filterLfo.connect(filterDepth);
      filterDepth.connect(sweep.frequency);
      gain.connect(sweep);
      voiceOut = sweep;
      oscillators.push(filterLfo);
      extraNodes.push(sweep, filterDepth);
    }
    if (species === 'pad' && (timbre.detuneModHz ?? 0) > 0 && toneOscillators.length) {
      const detuneLfo = ctx.createOscillator();
      detuneLfo.type = 'sine';
      detuneLfo.frequency.value = timbre.detuneModHz;
      const detuneDepth = ctx.createGain();
      detuneDepth.gain.value = timbre.detuneModCents ?? 4;
      detuneLfo.connect(detuneDepth);
      for (const osc of toneOscillators) detuneDepth.connect(osc.detune);
      oscillators.push(detuneLfo);
      extraNodes.push(detuneDepth);
    }
    const chain = connectTimbre(voiceOut, timbre, species);
    const dispose = () => {
      for (const node of extraNodes) {
        try { node.disconnect(); } catch { /* 已断开 */ }
      }
      chain.dispose();
    };
    for (const osc of oscillators) osc.start(t);
    sustainedVoices.set(birdId, { species, oscillators, gain, dispose, midi, role });
  }

  function refreshPadVoicing({ revoice = false } = {}) {
    if (!ctx || !padPerches.size) return;
    const timbre = cfg.audio.timbres.pad;
    const previous = new Map([...sustainedVoices]
      .filter(([, voice]) => voice.species === 'pad')
      .map(([birdId, voice]) => [birdId, { midi: voice.midi, role: voice.role }]));
    const [minMidi, maxMidi] = timbre.voicingRange ?? [52, 76];
    const assignments = mapping.padVoicingAssignments([...padPerches.values()], getChord(), {
      registerOffset: treeRegister.pad ?? 0, minMidi, maxMidi, previous,
    });
    for (const note of assignments) {
      startSustainedVoice('pad', note.birdId, {
        midi: note.midi,
        velocity: mapping.velocityFromPerchCount(note.perchedOnBranch, cfg.mapping),
        role: note.role,
      }, revoice);
    }
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

  // 未声明专用 engine 的兼容触发音色；现有四物种只由下方专用引擎消费。
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
      const { dispose, delayTailSeconds } = connectTimbre(gain, timbre, species);
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
  function scheduleBassPulses(world) {
    const species = 'bass';
    const timbre = cfg.audio.timbres[species];
    const perchedCount = bassPerches.size;
    if (!perchedCount) { silenceTriggered(species); neural.playPlan('bass', [], 0, 0); return; }
    silenceTriggered(species);
    const snapshot = world.getSnapshot();
    const density = clamp(Number(timbre.pulseDensityMax ?? 1));
    const highStep = timbre.lowTensionStepBeats
      + (timbre.highTensionStepBeats - timbre.lowTensionStepBeats) * density;
    const plan = [...bassPerches.values()].flatMap((entry) => bassPulsePlan({
      // 长驻鸟跨黎明不重落枝；每次重排仍须从“当前和弦 × 原物理枝”重读音高。
      midi: mapping.perchToNote(
        entry.event, getChord(), cfg, treeRegister[entry.event.treeId] ?? 0,
      ).midi,
      bpm: snapshot.bpm ?? cfg.tempo.defaultBpm, phase: snapshot.phase ?? 0,
      barsPerDay: cfg.tempo.barsPerDay, beatsPerBar: cfg.tempo.beatsPerBar,
      tension: currentTension(), lowStepBeats: timbre.lowTensionStepBeats,
      highStepBeats: highStep, tensionSplit: timbre.tensionDensitySplit,
    }));
    if (!plan.length) return;

    // 神经接管：整段脉冲 plan 转发给后端，不建本地振荡器链。见文件顶部
    // neural 对象的大注释——setTimeout 逐音符下发，没有采样级时钟。
    if (neural.owns('bass')) {
      neural.playPlan('bass', plan, timbre.sustainLevel, timbre.noteSeconds);
      return;
    }

    const bus = ctx.createGain();
    bus.gain.value = timbre.sustainLevel / Math.sqrt(perchedCount);
    const { dispose } = connectTimbre(bus, timbre, species);
    const sources = [];
    for (const note of plan) {
      const at = ctx.currentTime + note.offsetSeconds;
      const frequency = mapping.midiToFrequency(note.midi);
      // triangle soft bass：本枝三角波 + 基波正弦 + 二次谐波 → tanh 软饱和 → 包络。
      const mix = ctx.createGain();
      mix.gain.value = 1;
      const tri = ctx.createOscillator();
      tri.type = 'triangle';
      tri.frequency.value = frequency;
      tri.connect(mix);
      const fundamental = ctx.createOscillator();
      fundamental.type = 'sine';
      fundamental.frequency.value = frequency;
      const fundamentalGain = ctx.createGain();
      fundamentalGain.gain.value = timbre.subSineMix;
      fundamental.connect(fundamentalGain);
      fundamentalGain.connect(mix);
      const noteSources = [tri, fundamental];
      const harmonic2Mix = Number(timbre.harmonic2Mix) || 0;
      if (harmonic2Mix > 0) {
        const harmonic2 = ctx.createOscillator();
        harmonic2.type = 'sine';
        harmonic2.frequency.value = frequency * 2;
        const harmonic2Gain = ctx.createGain();
        harmonic2Gain.gain.value = harmonic2Mix;
        harmonic2.connect(harmonic2Gain);
        harmonic2Gain.connect(mix);
        noteSources.push(harmonic2);
      }
      const shaper = ctx.createWaveShaper();
      shaper.curve = saturationCurve(timbre.saturationDrive);
      shaper.oversample = cfg.audio.saturationOversample;
      mix.connect(shaper);
      const noteGain = ctx.createGain();
      noteGain.gain.setValueAtTime(0, at);
      noteGain.gain.linearRampToValueAtTime(1, at + timbre.attackSeconds);
      // 主体内 exp(-t/τ) 衰减：指数斜坡到 τ 对应的剩余电平，再短释放归零
      const sustainValue = Math.max(0.001,
        Math.exp(-(timbre.noteSeconds - timbre.attackSeconds) / timbre.decayTauSeconds));
      noteGain.gain.exponentialRampToValueAtTime(sustainValue, at + timbre.noteSeconds);
      noteGain.gain.exponentialRampToValueAtTime(0.001, at + timbre.noteSeconds + timbre.releaseSeconds);
      shaper.connect(noteGain);
      noteGain.connect(bus);
      for (const source of noteSources) {
        source.start(at);
        source.stop(at + timbre.noteSeconds + timbre.releaseSeconds + 0.02);
        sources.push(source);
      }
    }
    triggeredVoices.set(species, [{ sources, gain: bus, dispose }]);
  }

  function triggerSineWhistle(event, note) {
    const species = 'melody';
    const timbre = cfg.audio.timbres[species];
    silenceTriggered(species);
    const registerOffset = treeRegister[event.treeId] ?? 0;
    // melody-only：短句池走密音格；缺省回退和弦音。bass/pad/texture 仍读 .notes。
    const chordNotes = (getChord()?.melodyNotes ?? getChord()?.notes ?? [])
      .map((midi) => midi + registerOffset);
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

    // 神经接管：整段乐句 plan 转发给后端，不建本地振荡器链。音高要带上
    // timbre.outputOctave 移调——本地合成用的就是移调后的频率（见下方
    // frequency 那行），神经这边不转发原始 phraseNote.midi 的话音高会对不上。
    if (neural.owns('melody')) {
      const transposed = phrase.map((phraseNote) => ({
        ...phraseNote, midi: phraseNote.midi + timbre.outputOctave,
      }));
      neural.playPlan('melody', transposed, note.velocity * timbre.sustainLevel);
      return;
    }

    const bus = ctx.createGain();
    bus.gain.value = note.velocity * timbre.sustainLevel;
    const { dispose } = connectTimbre(bus, timbre, species);
    const sources = [];
    let previousFrequency = null;
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
      // 滑音：句首音自 glideFromCents 下方滑入，后续音自上一音滑向目标（鸟鸣）
      const glideFrom = previousFrequency
        ?? frequency * 2 ** (-(timbre.glideFromCents ?? 0) / 1200);
      if ((timbre.glideSeconds ?? 0) > 0 && glideFrom !== frequency) {
        carrier.frequency.setValueAtTime(glideFrom, at);
        carrier.frequency.exponentialRampToValueAtTime(frequency, at + timbre.glideSeconds);
      } else {
        carrier.frequency.setValueAtTime(frequency, at);
      }
      carrier.connect(env);

      // 轻颤音：起音先直后颤，深度淡入，只调载波 detune
      const vibrato = ctx.createOscillator();
      vibrato.type = 'sine';
      vibrato.frequency.value = timbre.vibratoHz;
      const vibratoDepth = ctx.createGain();
      const vibratoStart = at + (timbre.vibratoDelaySeconds ?? 0);
      vibratoDepth.gain.setValueAtTime(0, vibratoStart);
      vibratoDepth.gain.linearRampToValueAtTime(timbre.vibratoCents, vibratoStart + duration * 0.55);
      vibrato.connect(vibratoDepth);
      vibratoDepth.connect(carrier.detune);

      // 极轻呼吸调幅：13.7Hz LFO 叠加在包络上
      const breath = ctx.createOscillator();
      breath.type = 'sine';
      breath.frequency.value = timbre.breathHz;
      const breathDepth = ctx.createGain();
      breathDepth.gain.value = timbre.breathDepth;
      breath.connect(breathDepth);
      breathDepth.connect(env.gain);

      for (const source of [carrier, vibrato, breath]) {
        source.start(at);
        source.stop(at + duration + timbre.releaseSeconds + 0.02);
        sources.push(source);
      }
      previousFrequency = frequency;
    }
    triggeredVoices.set(species, [{ sources, gain: bus, dispose }]);
  }

  function triggerGranular(event, note) {
    const species = 'texture';
    const timbre = cfg.audio.timbres[species];
    silenceTriggered(species);
    granularSeed += 1;
    const peckRand = mulberry32((Math.abs(granularSeed) || 1) * 997 + Number(event.birdId) * 131);
    // D2：每次啄抽一档音色——Q / 带偏置 / 起音 / 播放速率 / 偶发高通
    const qLo = timbre.peckQRange?.[0] ?? timbre.grainQ ?? 1.2;
    const qHi = timbre.peckQRange?.[1] ?? qLo;
    const peckQ = qLo + peckRand() * Math.max(0, qHi - qLo);
    const bandJitter = (peckRand() * 2 - 1) * (timbre.peckBandJitterHz ?? 0);
    const atkLo = timbre.peckAttackSecondsRange?.[0] ?? 0.004;
    const atkHi = timbre.peckAttackSecondsRange?.[1] ?? atkLo;
    const peckAttack = atkLo + peckRand() * Math.max(0, atkHi - atkLo);
    const rateLo = timbre.peckPlaybackRateRange?.[0] ?? 1;
    const rateHi = timbre.peckPlaybackRateRange?.[1] ?? 1;
    const peckRate = rateLo + peckRand() * Math.max(0, rateHi - rateLo);
    const useHighpass = peckRand() < (timbre.peckHighpassChance ?? 0);

    const lo = timbre.grainCount?.[0] ?? 5;
    const hi = Math.min(timbre.grainCount?.[1] ?? 12, timbre.grainCountMax ?? 12);
    const plan = granularPlan({
      tension: currentTension(),
      seed: granularSeed + Number(event.birdId) * 31,
      countRange: [lo, Math.max(lo, hi)],
      secondsRange: timbre.grainSeconds,
      gapRange: timbre.grainGapSeconds,
      bandRange: timbre.grainBandHz,
    });
    const bus = ctx.createGain();
    bus.gain.value = note.velocity * timbre.sustainLevel;
    const { dispose } = connectTimbre(bus, timbre, species);
    const sources = [];
    for (const grain of plan) {
      const at = ctx.currentTime + grain.offsetSeconds;
      const source = ctx.createBufferSource();
      source.buffer = noiseBuffer;
      source.playbackRate.value = peckRate;
      const band = ctx.createBiquadFilter();
      band.type = useHighpass ? 'highpass' : 'bandpass';
      band.frequency.value = Math.max(80, grain.centerHz + bandJitter);
      band.Q.value = peckQ;
      const env = ctx.createGain();
      const attack = Math.min(peckAttack, grain.durationSeconds / 3);
      env.gain.setValueAtTime(0.001, at);
      env.gain.linearRampToValueAtTime(1, at + attack);
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
    const settleAudioLevels = (stats) => {
      const audioLevels = getAudioLevels({ sample: true, reset: true });
      if (stats && typeof stats === 'object') stats.audioLevels = audioLevels;
    };
    // 与 economy.finishDay 同在黎明前关账，中间不留额外音频采样窗口。
    const settlesBeforeDawn = typeof world.onBeforeDawn === 'function';
    if (settlesBeforeDawn) world.onBeforeDawn(({ stats } = {}) => settleAudioLevels(stats));
    // setTempo 后重排 bass 脉冲：已挂 AudioParam 时刻按旧 BPM 算的 offset 会相对新拍网格漂移。
    const originalSetTempo = typeof world.setTempo === 'function'
      ? world.setTempo.bind(world) : null;
    if (originalSetTempo) {
      world.setTempo = (bpm) => {
        const ok = originalSetTempo(bpm);
        if (ok && ctx && bassPerches.size > 0) {
          scheduleBassPulses(world);
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
      perched.add(event.birdId);
      const note = mapping.perchToNote(event, getChord(), cfg, treeRegister[event.treeId] ?? 0);
      if (species === 'bass') bassPerches.set(event.birdId, { event, midi: note.midi });
      // pad 神经接管：抢占神经行（last-note-priority），这只鸟**不**进本地和弦
      // 聚合（padPerches），避免同一只鸟本地+神经双重发声。见上方大注释。
      if (species === 'pad' && neural.owns('pad')) {
        neural.neuralPadBirdId = event.birdId;
        neural.holdNote('pad', note.midi, note.velocity);
      } else if (species === 'pad') {
        padPerches.set(event.birdId, event);
      }
      if (!ctx) return;
      applyDaylight(world.getSnapshot().daylight);
      if (timbre.engine === 'trianglePulse') {
        scheduleBassPulses(world);
      } else if (timbre.engine === 'sineWhistle') {
        triggerSineWhistle(event, note);
      } else if (timbre.engine === 'granular') {
        triggerGranular(event, note);
      } else if (species === 'pad') {
        refreshPadVoicing();
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
      if (species === 'pad') {
        padPerches.delete(event.birdId);
        // 只在这只鸟确实是当前神经行的主人时才 release——较早神经接管的鸟
        // 落后于新鸟才 unperch 时，神经行早已换成新音，不该被它打断。
        if (neural.neuralPadBirdId === event.birdId) {
          neural.releaseNote('pad');
          neural.neuralPadBirdId = null;
        }
      }
      if (species === 'bass') bassPerches.delete(event.birdId);
      if (!ctx) return;
      if (timbre?.engine === 'trianglePulse') {
        if (bassPerches.size === 0) silenceTriggered(species);
        else scheduleBassPulses(world);
        return;
      }
      if (!timbre?.polyphonic) return; // 触发型音色自然衰减
      mapping.unperchToRelease(event, getChord(), cfg, treeRegister[event.treeId] ?? 0);
      stopSustainedVoice(event.birdId);
      if (species === 'pad') refreshPadVoicing({ revoice: true });
    });
    world.on('dawn', (event) => {
      // 兼容无 onBeforeDawn 的外部 world 适配器；正式 world 已在同日界关账。
      if (!settlesBeforeDawn) settleAudioLevels(event?.stats);
      if (!ctx) return;
      applyDaylight(world.getSnapshot().daylight); // 晨鸣已摘除：黎明只剩昼夜宏切换
      // pad 鸟可跨黎明长驻；每日色彩和弦改变时，以最近八度重排并交叉慢起慢收。
      refreshPadVoicing({ revoice: true });
      if (bassPerches.size > 0) {
        scheduleBassPulses(world);
      }
    });
  }

  function describeVoices() {
    return Object.fromEntries(Object.entries(cfg.audio.timbres).map(([species, timbre]) => [species, { ...timbre }]));
  }

  function listMixParams(species) {
    return [...(MIX_PARAM_SPECS.common ?? []), ...(MIX_PARAM_SPECS[species] ?? [])];
  }

  function getMixParams(species) {
    const timbre = cfg.audio.timbres[species];
    if (!timbre) return null;
    const out = {};
    for (const spec of listMixParams(species)) out[spec.key] = timbre[spec.key];
    return out;
  }

  // R3：运行时写 timbre 副本字段；总线类立即 setTarget，调度类影响下一次发声。
  function setParam(species, key, rawValue) {
    const timbre = cfg.audio.timbres[species];
    if (!timbre) return false;
    const spec = listMixParams(species).find((entry) => entry.key === key);
    if (!spec) return false;
    let value = Number(rawValue);
    if (!Number.isFinite(value)) return false;
    value = Math.max(spec.min, Math.min(spec.max, value));
    if (spec.step >= 1) value = Math.round(value);
    timbre[key] = value;
    if (!ctx) return true;
    const bus = speciesBuses.get(species) ?? (ctx ? ensureSpeciesBus(species) : null);
    const t = ctx.currentTime;
    if (key === 'gain' && bus) bus.gain.gain.setTargetAtTime(value, t, 0.03);
    else if (key === 'eqLowDb' && bus) bus.low.gain.setTargetAtTime(value, t, 0.03);
    else if (key === 'eqMidDb' && bus) bus.mid.gain.setTargetAtTime(value, t, 0.03);
    else if (key === 'eqHighDb' && bus) bus.high.gain.setTargetAtTime(value, t, 0.03);
    else if (key === 'reverbSend') refreshBusSend(species);
    else if (key === 'pulseDensityMax' && species === 'bass' && attachedWorld
      && bassPerches.size > 0) {
      scheduleBassPulses(attachedWorld);
    }
    return true;
  }

  // 特写：非焦点树混响发送 ×0.5；退出全还原。只动缩放，不改用户 reverbSend 设定。
  function setZoomFocus(focusTreeId) {
    for (const tree of cfg.trees) {
      const species = tree.species;
      zoomReverbScale[species] = focusTreeId && tree.id !== focusTreeId ? 0.5 : 1;
      refreshBusSend(species);
    }
  }

  // WS-2：per-voice mute/solo（纯播放层；静音时仍累计 analyser，便于电平表观察）。
  function setMute(species, muted) {
    if (!(species in muteBySpecies)) return false;
    muteBySpecies[species] = !!muted;
    if (ctx) ensureSpeciesBus(species);
    refreshMuteSoloGates();
    return true;
  }

  function setSolo(species, soloed) {
    if (!(species in soloBySpecies)) return false;
    soloBySpecies[species] = !!soloed;
    if (ctx) ensureSpeciesBus(species);
    refreshMuteSoloGates();
    return true;
  }

  function getMuteSolo() {
    return {
      mute: { ...muteBySpecies },
      solo: { ...soloBySpecies },
    };
  }

  function getRecordingTap() {
    return ctx && master ? { audioContext: ctx, sourceNode: master } : null;
  }

  return {
    // 神经音源桥：roamTo(species, [x,y], k) 换该物种在自己漫游地图上的坐标；
    // isNeural(species) 看该物种是否已被神经接管（未接管/未连上都是 false）。
    roamTo: (species, xy, k) => neural.roamTo(species, xy, k),
    isNeural: (species) => neural.owns(species),
    start, attach, describeVoices, getRecordingTap, getAudioLevels,
    setParam, getMixParams, listMixParams, setZoomFocus,
    setMute, setSolo, getMuteSolo,
    isRunning: () => !!ctx && ctx.state === 'running',
  };
}
