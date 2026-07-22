import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bassPulsePlan, createAudioEngine, granularPlan, melodyPhrasePlan } from '../src/audio.js';
import { CONFIG } from '../src/config.js';
import { midiToFrequency } from '../src/mapping.js';

class FakeParam {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]); }
  linearRampToValueAtTime(value, time) { this.value = value; this.events.push(['linear', value, time]); }
  exponentialRampToValueAtTime(value, time) { this.value = value; this.events.push(['exponential', value, time]); }
  setTargetAtTime(value, time, constant) { this.value = value; this.events.push(['target', value, time, constant]); }
  cancelScheduledValues() {}
}

class FakeNode {
  constructor() { this.connections = []; this.disconnectCalls = 0; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnectCalls += 1; }
}

class FakeOscillator extends FakeNode {
  constructor() {
    super();
    this.frequency = new FakeParam();
    this.detune = new FakeParam();
    this.started = [];
    this.stopped = [];
  }
  start(time) { this.started.push(time); }
  stop(time) { this.stopped.push(time); }
}

class FakeBufferSource extends FakeNode {
  constructor() {
    super();
    this.buffer = null;
    this.playbackRate = new FakeParam(1);
    this.started = [];
    this.startArgs = [];
    this.stopped = [];
  }
  start(time, offset, duration) {
    this.started.push(time);
    this.startArgs.push([time, offset, duration]);
  }
  stop(time) { this.stopped.push(time); }
}

class FakeAnalyser extends FakeNode {
  constructor() {
    super();
    this.fftSize = 256;
    this.sampleValue = 0;
  }
  getFloatTimeDomainData(target) { target.fill(this.sampleValue); }
}

class FakeAudioContext {
  static latest = null;
  constructor() {
    this.currentTime = 0;
    this.state = 'suspended';
    this.sampleRate = 48000;
    this.destination = new FakeNode();
    this.oscillators = [];
    this.bufferSources = [];
    this.filters = [];
    this.shapers = [];
    this.delays = [];
    this.gains = [];
    this.convolvers = [];
    this.compressors = [];
    this.analysers = [];
    FakeAudioContext.latest = this;
  }
  createGain() {
    const node = new FakeNode();
    node.gain = new FakeParam();
    this.gains.push(node);
    return node;
  }
  createBiquadFilter() {
    const node = new FakeNode();
    node.type = '';
    node.frequency = new FakeParam();
    node.Q = new FakeParam();
    node.gain = new FakeParam();
    this.filters.push(node);
    return node;
  }
  createWaveShaper() {
    const node = new FakeNode();
    node.curve = null;
    node.oversample = 'none';
    this.shapers.push(node);
    return node;
  }
  createDelay() {
    const node = new FakeNode();
    node.delayTime = new FakeParam();
    this.delays.push(node);
    return node;
  }
  createConvolver() {
    const node = new FakeNode();
    node.buffer = null;
    this.convolvers.push(node);
    return node;
  }
  createDynamicsCompressor() {
    const node = new FakeNode();
    node.threshold = new FakeParam();
    node.knee = new FakeParam();
    node.ratio = new FakeParam();
    node.attack = new FakeParam();
    node.release = new FakeParam();
    this.compressors.push(node);
    return node;
  }
  createAnalyser() {
    const node = new FakeAnalyser();
    this.analysers.push(node);
    return node;
  }
  createBuffer(channels, length) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: (ch) => data[ch] };
  }
  createBufferSource() {
    const source = new FakeBufferSource();
    this.bufferSources.push(source);
    return source;
  }
  createOscillator() {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
  async decodeAudioData() { return { duration: 4 }; }
  async resume() { this.state = 'running'; }
}

function fakeWorld({ bpm = 60, phase = 0 } = {}) {
  const listeners = new Map();
  const beforeDawn = new Set();
  let currentBpm = bpm;
  const world = {
    on(type, listener) { listeners.set(type, listener); },
    emit(type, event) { listeners.get(type)?.(event); },
    onBeforeDawn(listener) { beforeDawn.add(listener); return () => beforeDawn.delete(listener); },
    emitBeforeDawn(event) { for (const listener of beforeDawn) listener(event); },
    getSnapshot() { return { daylight: 1, birds: [], bpm: currentBpm, phase }; },
    setTempo(next) {
      const value = Number(next);
      if (!Number.isFinite(value) || value <= 0) return false;
      currentBpm = value;
      return true;
    },
  };
  return world;
}

async function withEngine(run, { tension = 0.2, bpm = 60, phase = 0,
  chord = { notes: [48, 52, 55, 60, 64] } } = {}) {
  const original = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  });
  try {
    const world = fakeWorld({ bpm, phase });
    const engine = createAudioEngine({
      config: CONFIG,
      getChord: () => chord,
      getFrame: () => ({ tension }),
    });
    await engine.start();
    engine.attach(world);
    return await run({ engine, world, context: FakeAudioContext.latest });
  } finally {
    if (original === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = original;
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
}

test('四物种按 engine/polyphonic 数据路由，pad 为 additive sine 持续音', async () => {
  await withEngine(async ({ engine, world, context }) => {
    const voices = engine.describeVoices();
    assert.deepEqual(Object.keys(voices), ['pad', 'melody', 'bass', 'texture']);
    assert.deepEqual(Object.fromEntries(Object.entries(voices).map(([id, voice]) => [id, voice.engine])), {
      pad: 'sustained', melody: 'sineWhistle', bass: 'trianglePulse', texture: 'percussionHabitat',
    });
    assert.equal(context.compressors.length, 1, 'master 输出必须经过唯一隐藏 limiter');
    const limiter = context.compressors[0];
    assert.deepEqual(
      [limiter.threshold.value, limiter.knee.value, limiter.ratio.value],
      [-1, 0, 20],
    );
    assert.equal(engine.getRecordingTap().sourceNode, limiter, '录制也必须拿 limiter 后的安全输出');
    world.emit('perch', { treeId: 'pad', birdId: 1, branchId: 2, perchedOnBranch: 1 });
    const { partials, detuneCents, breatheHz, chorus, filterModHz, detuneModHz } = CONFIG.audio.timbres.pad;
    const toneCount = partials.length * detuneCents.length;
    const slowModCount = (filterModHz > 0 ? 1 : 0) + (detuneModHz > 0 ? 1 : 0);
    assert.equal(context.oscillators.length, toneCount + 1 + slowModCount + chorus.delaySeconds.length,
      'pad = 泛音×微失谐簇 + 呼吸 LFO + D1 慢调制 LFO + 双路 chorus LFO');
    const base = context.oscillators[0].frequency.value / partials[0][0];
    for (let partial = 0; partial < partials.length; partial += 1) {
      for (let detune = 0; detune < detuneCents.length; detune += 1) {
        const osc = context.oscillators[partial * detuneCents.length + detune];
        assert.equal(osc.type, 'sine', '泛音簇全部为正弦');
        assert.equal(osc.detune.value, detuneCents[detune]);
        assert.ok(Math.abs(osc.frequency.value - base * partials[partial][0]) < 1e-9,
          `泛音 ${partial} 按频率比叠加并作微失谐`);
      }
    }
    const lfo = context.oscillators[toneCount];
    assert.equal(lfo.frequency.value, breatheHz, '呼吸调幅 LFO 频率');
    assert.ok(Array.isArray(lfo.connections[0]?.connections[0]?.events),
      '呼吸 LFO 经深度增益挂到包络 gain AudioParam');
    const filterLfo = context.oscillators[toneCount + 1];
    assert.equal(filterLfo.frequency.value, filterModHz, 'D1 滤波扫 LFO 慢速');
    assert.ok(context.filters.some((f) => f.type === 'lowpass'
      && Math.abs(f.frequency.value - CONFIG.audio.timbres.pad.filterModBaseHz) < 1e-6),
      'D1 慢扫低通以 filterModBaseHz 为中心');
    const detuneLfo = context.oscillators[toneCount + 2];
    assert.equal(detuneLfo.frequency.value, detuneModHz, 'D1 微失谐漂移 LFO 慢速');
    assert.ok(context.filters.some((f) => f.type === 'highpass' && f.frequency.value === 180),
      'pad 高通 180Hz 给 bass 让位');
    assert.equal(context.delays.length, 10, '四轨各两路 ping-pong + pad 双路 chorus');
    assert.deepEqual(context.delays.slice(-2).map((node) => node.delayTime.value), chorus.delaySeconds,
      '最后两路短延迟仍是 pad chorus');
  });
});

test('pad 三鸟逐只回声本枝；同枝允许同音，跨黎明仍按本枝重配', async () => {
  const chord = { notes: [48, 52, 55, 60, 64] };
  await withEngine(async ({ world, context }) => {
    world.emit('perch', { treeId: 'pad', birdId: 0, branchId: 4, perchedOnBranch: 3 });
    world.emit('perch', { treeId: 'pad', birdId: 1, branchId: 4, perchedOnBranch: 3 });
    world.emit('perch', { treeId: 'pad', birdId: 2, branchId: 4, perchedOnBranch: 3 });
    const oscillatorsPerVoice = CONFIG.audio.timbres.pad.partials.length
      * CONFIG.audio.timbres.pad.detuneCents.length + 1
      + (CONFIG.audio.timbres.pad.filterModHz > 0 ? 1 : 0)
      + (CONFIG.audio.timbres.pad.detuneModHz > 0 ? 1 : 0)
      + CONFIG.audio.timbres.pad.chorus.delaySeconds.length;
    const roots = [0, 1, 2].map((voice) => context.oscillators[voice * oscillatorsPerVoice].frequency.value);
    assert.equal(new Set(roots.map(Math.round)).size, 1,
      '三鸟全落同一枝发同一基频，不由音频层补写和弦角色');
    const before = context.oscillators.length;
    chord.notes = [48, 55, 60, 65, 67];
    world.emit('dawn', { day: 2, stats: {} });
    assert.ok(context.oscillators.length > before, '跨黎明色彩枝改变会新建交叉淡变声部');
  }, { chord });
});

test('每声部 Analyser 累计日 RMS/峰值并写入 dawn dayStats（不入分）', async () => {
  await withEngine(async ({ engine, world, context }) => {
    assert.equal(context.analysers.length, 4, '四声部各一个持久分析位');
    const values = [0.1, 0.2, 0.3, 0.4];
    context.analysers.forEach((analyser, index) => { analyser.sampleValue = values[index]; });
    const live = engine.getAudioLevels();
    assert.deepEqual(Object.keys(live), ['pad', 'melody', 'bass', 'texture']);
    assert.ok(Math.abs(live.pad.rms - 0.1) < 1e-6);
    assert.ok(Math.abs(live.texture.peak - 0.4) < 1e-6);
    const dryFilter = context.filters.find((node) => node.type === 'lowpass'
      && node.frequency.value === CONFIG.audio.filterBaseHz);
    const firstHigh = context.filters.find((node) => node.type === 'highshelf');
    const gate = firstHigh.connections.find((node) => node
      && typeof node.gain === 'object' && node.connections?.includes(dryFilter));
    assert.ok(gate, '干声主干 high→gate→filter（mute/solo gate）');
    assert.ok(firstHigh.connections.includes(context.analysers[0]), 'high 另分支到 analyser tap（gate 前）');
    assert.equal(context.analysers[0].connections.length, 0, 'analyser 不得串入任何发声下游');

    const stats = { day: 1, trees: {} };
    world.emitBeforeDawn({ day: 2, stats });
    world.emit('dawn', { day: 2, stats });
    assert.ok(Math.abs(stats.audioLevels.bass.rms - 0.3) < 1e-6);
    assert.ok(Math.abs(stats.audioLevels.melody.peak - 0.2) < 1e-6);
    assert.ok(stats.audioLevels.pad.samples > 0);
    assert.deepEqual(engine.getAudioLevels({ sample: false }), {
      pad: { rms: 0, peak: 0, samples: 0 },
      melody: { rms: 0, peak: 0, samples: 0 },
      bass: { rms: 0, peak: 0, samples: 0 },
      texture: { rms: 0, peak: 0, samples: 0 },
    }, '日结后分析窗口复位');
  });
});

test('bass 三角波本枝脉冲：每鸟固定本低枝音，tanh 软饱和且按拍呼吸', async () => {
  const pure = bassPulsePlan({
    midi: 36, bpm: 120, phase: 0, barsPerDay: 4, beatsPerBar: 4, tension: 0.2,
  });
  assert.deepEqual(pure.slice(0, 4).map((note) => note.midi), [36, 36, 36, 36]);
  assert.deepEqual(pure.slice(0, 4).map((note) => note.offsetSeconds), [0, 0.5, 1, 1.5]);

  await withEngine(async ({ world, context }) => {
    const busDelayCount = context.delays.length;
    world.emit('perch', { treeId: 'bass', birdId: 20, branchId: 0, perchedOnBranch: 1 });
    assert.equal(context.delays.length, busDelayCount, '三角波脉冲不额外创建逐音延迟线');
    assert.equal(context.bufferSources.length, 0, '三角波脉冲不使用噪声激励');
    const triangles = context.oscillators.filter((osc) => osc.type === 'triangle');
    const sines = context.oscillators.filter((osc) => osc.type === 'sine');
    assert.equal(triangles.length, 16, '低 tension 每拍一音，一昼夜 16 拍');
    assert.equal(sines.length, 32, '每音：基波正弦 + 二次谐波（C5 提亮）');
    assert.deepEqual(triangles.slice(0, 4).map((osc) => osc.started[0]), [0, 1, 2, 3]);
    assert.ok(Math.abs(triangles[0].frequency.value - midiToFrequency(24)) < 1e-9,
      '三角波按枝映射后的低音频率发声');
    const fundamentals = sines.filter((osc) => Math.abs(osc.frequency.value - triangles[0].frequency.value) < 1e-9);
    const harmonics = sines.filter((osc) => Math.abs(osc.frequency.value - triangles[0].frequency.value * 2) < 1e-9);
    assert.equal(fundamentals.length, 16, '基波正弦与三角波同频');
    assert.equal(harmonics.length, 16, '二次谐波为基频×2');
    world.emit('perch', { treeId: 'bass', birdId: 21, branchId: 1, perchedOnBranch: 1 });
    const rescheduled = context.oscillators.filter((osc) => osc.type === 'triangle').slice(-32);
    assert.equal(new Set(rescheduled.slice(0, 16).map((osc) => osc.frequency.value)).size, 1,
      '第一只鸟整日只重复枝0音');
    assert.equal(new Set(rescheduled.slice(16).map((osc) => osc.frequency.value)).size, 1,
      '第二只鸟整日只重复枝1音');
    assert.notEqual(rescheduled[0].frequency.value, rescheduled[16].frequency.value,
      '不同低枝的两只鹈鹕保留各自枝音，不共享隐藏音池');
    assert.ok(context.gains.some((node) => node.gain.value === CONFIG.audio.timbres.bass.subSineMix),
      '基波正弦按 subSineMix 比例混入');
    assert.ok(context.gains.some((node) => node.gain.value === CONFIG.audio.timbres.bass.harmonic2Mix),
      '二次谐波按 harmonic2Mix 比例混入');
    assert.ok(context.shapers.length >= 16, '每次本枝脉冲都有 tanh 软饱和 WaveShaper');
    assert.ok(context.shapers.every((node) => node.curve?.length > 0
      && node.oversample === CONFIG.audio.saturationOversample), '饱和曲线与过采样生效');
    const { attackSeconds, noteSeconds, releaseSeconds, decayTauSeconds } = CONFIG.audio.timbres.bass;
    const sustainValue = Math.exp(-(noteSeconds - attackSeconds) / decayTauSeconds);
    const env = context.gains.find((node) => node.gain.events.length === 4
      && node.gain.events[0][0] === 'set' && node.gain.events[0][1] === 0
      && node.gain.events[1][0] === 'linear' && node.gain.events[1][1] === 1);
    assert.ok(env, '每音一个起音/衰减/释放包络');
    assert.ok(Math.abs(env.gain.events[1][2] - attackSeconds) < 1e-9, '快速起音瞬态');
    assert.ok(Math.abs(env.gain.events[2][1] - sustainValue) < 1e-6
      && Math.abs(env.gain.events[2][2] - noteSeconds) < 1e-9, '主体内 exp(-t/τ) 指数衰减');
    assert.ok(Math.abs(env.gain.events[3][1] - 0.001) < 1e-12
      && Math.abs(env.gain.events[3][2] - (noteSeconds + releaseSeconds)) < 1e-9, '短释放归零');
    assert.ok(context.filters.some((f) => f.type === 'lowpass' && f.frequency.value === 1400),
      'C5：1400Hz 低通放行高频');
    assert.ok(context.filters.some((f) => f.type === 'highpass' && f.frequency.value === 50));
    world.emit('unperch', { treeId: 'bass', birdId: 20, branchId: 0, dwellTime: 2 });
    world.emit('unperch', { treeId: 'bass', birdId: 21, branchId: 1, dwellTime: 2 });
    assert.ok(context.oscillators.every((osc) => osc.stopped.length >= 2), '最后一只离枝立即静音已排脉冲');
  }, { tension: 0.2, chord: { notes: [48, 55, 60, 64, 67] } });

  await withEngine(async ({ world, context }) => {
    world.emit('perch', { treeId: 'bass', birdId: 21, branchId: 0, perchedOnBranch: 1 });
    const triangles = context.oscillators.filter((osc) => osc.type === 'triangle');
    assert.equal(triangles.length, 32, '高 tension 每半拍一音');
    assert.deepEqual(triangles.slice(0, 4).map((osc) => osc.started[0]), [0, 0.5, 1, 1.5]);
  }, { tension: 0.9, chord: { notes: [48, 55, 60, 64, 67] } });
});

test('melody 正弦鸟鸣：颤音延迟淡入 + 呼吸 + 滑音，框架内 2–4 音级进', async () => {
  const timbre = CONFIG.audio.timbres.melody;
  const phrase = melodyPhrasePlan({ targetMidi: 67, chordNotes: [60, 64, 67, 72, 76], seed: 44,
    minSeconds: timbre.noteMinSeconds, maxSeconds: timbre.noteMaxSeconds });
  assert.ok(phrase.length >= 2 && phrase.length <= 4);
  assert.equal(phrase.at(-1).midi, 67, '短句末音必须落到目标枝音');
  assert.ok(phrase.every((note, index) => index === 0
    || Math.abs([60, 64, 67, 72, 76].indexOf(note.midi) - [60, 64, 67, 72, 76].indexOf(phrase[index - 1].midi)) === 1),
  '短句只在框架内相邻音级级进');

  await withEngine(async ({ world, context }) => {
    world.emit('perch', { treeId: 'melody', birdId: 10, branchId: 2, perchedOnBranch: 1 });
    assert.equal(context.oscillators.length, phrase.length * 3, '每音 = 载波 + 颤音 LFO + 呼吸 LFO');
    let previousFrequency = null;
    for (let index = 0; index < phrase.length; index += 1) {
      const [carrier, vibrato, breath] = context.oscillators.slice(index * 3, index * 3 + 3);
      const at = phrase[index].offsetSeconds;
      assert.equal(carrier.type, 'sine', '纯正弦载波');
      const targetFrequency = midiToFrequency(phrase[index].midi + timbre.outputOctave);
      const glideFrom = previousFrequency ?? targetFrequency * 2 ** (-timbre.glideFromCents / 1200);
      assert.ok(Math.abs(carrier.frequency.events[0][1] - glideFrom) < 1e-9
        && Math.abs(carrier.frequency.events[0][2] - at) < 1e-9
        && carrier.frequency.events[1][0] === 'exponential'
        && Math.abs(carrier.frequency.events[1][1] - targetFrequency) < 1e-9
        && Math.abs(carrier.frequency.events[1][2] - (at + timbre.glideSeconds)) < 1e-9,
      '滑音：句首自下方 glideFromCents、后续自上一音滑向目标');
      assert.equal(vibrato.frequency.value, timbre.vibratoHz);
      assert.equal(vibrato.connections[0].connections[0], carrier.detune, '颤音只调载波 detune');
      assert.ok(Math.abs(vibrato.connections[0].gain.events[0][2] - (at + timbre.vibratoDelaySeconds)) < 1e-9,
        '颤音延迟 35ms 再淡入（起音先直后颤）');
      assert.equal(breath.frequency.value, timbre.breathHz);
      assert.equal(breath.connections[0].gain.value, timbre.breathDepth);
      assert.equal(breath.connections[0].connections[0], carrier.connections[0].gain,
        '呼吸调幅挂在音头包络 gain 上');
      previousFrequency = targetFrequency;
    }
  });
});

test('texture Jungle：一个生态 cell 触发一片颗粒化真实 Amen slice', async () => {
  await withEngine(async ({ engine, world, context }) => {
    world.emit('perch', {
      treeId: 'texture', birdId: 30, branchId: 0, pitchBranchId: 0,
      stepIndex: 4, perchedOnBranch: 1,
    });
    assert.ok(context.bufferSources.length > 1, '一个 slice 用交叉颗粒解耦 tempo 与 pitch');
    assert.equal(context.oscillators.length, 0, 'sample 就绪时不混入合成鼓');
    const [, offset] = context.bufferSources[0].startArgs[0];
    assert.equal(offset, 1, 'stepIndex=4 读取 32-slice 网格的第 8 格');
    assert.ok(context.bufferSources.every((source) => source.loop), '尾部颗粒可跨 WAV 边界环回');
    assert.ok(Math.abs(Math.max(...context.bufferSources.map((source) => source.stopped[0])) - (60 / 164)) < 1e-9,
      'Master 82 对应 Jungle 164，slice 精确停在下一拍');
    assert.equal(engine.getJungleSampleState().status, 'ready');
    assert.equal(engine.getJungleSampleState().duration, 4);
  }, { tension: 0.45, bpm: 82 });
});

test('texture 五枝只改变 slice pitch，WAV offset 与输出时值保持一致', async () => {
  await withEngine(async ({ world, context }) => {
    world.emit('perch', {
      treeId: 'texture', birdId: 50, branchId: 0, pitchBranchId: 0,
      stepIndex: 0, perchedOnBranch: 1,
    });
    const lowSources = context.bufferSources.slice();
    world.emit('perch', {
      treeId: 'texture', birdId: 50, branchId: 4, pitchBranchId: 4,
      stepIndex: 0, perchedOnBranch: 1,
    });
    const highSources = context.bufferSources.slice(lowSources.length);
    assert.ok(lowSources.length > 1 && highSources.length === lowSources.length,
      '每片使用数量一致的颗粒网格');
    assert.deepEqual(highSources.map((source) => source.started[0]), lowSources.map((source) => source.started[0]),
      '不同音高共用同一输出时间轴');
    assert.deepEqual(highSources.map((source) => source.stopped[0]), lowSources.map((source) => source.stopped[0]),
      '不同音高的每个颗粒都同时结束');
    assert.deepEqual(highSources.map((source) => source.startArgs[0][1]),
      lowSources.map((source) => source.startArgs[0][1]), '同一步按同一 tempo 轨迹读取 WAV');
    assert.ok(lowSources[0].playbackRate.value < highSources[0].playbackRate.value,
      '低枝与高枝只在颗粒内保留移调顺序');
    assert.ok(Math.abs((highSources[0].playbackRate.value / lowSources[0].playbackRate.value)
      - (2 ** (14 / 12))) < 1e-9, '五枝首尾仍相差 14 半音');
    assert.equal(Math.max(...highSources.map((source) => source.stopped[0])), 0.5,
      'Master 60 / Jungle 120 每片正好 500ms');
  }, { tension: 0.8 });
});

test('texture Jungle 跟随 Master 50–90 BPM，输出始终占满下一个双速步进', async () => {
  const probe = async (bpm) => withEngine(async ({ world, context }) => {
    world.emit('perch', {
      treeId: 'texture', birdId: bpm, branchId: 2, pitchBranchId: 2,
      stepIndex: 0, perchedOnBranch: 1,
    });
    return {
      stop: Math.max(...context.bufferSources.map((source) => source.stopped[0])),
      rates: context.bufferSources.map((source) => source.playbackRate.value),
    };
  }, { bpm });
  const slow = await probe(50);
  const fast = await probe(90);
  assert.ok(Math.abs(slow.stop - 0.6) < 1e-9);
  assert.ok(Math.abs(fast.stop - (1 / 3)) < 1e-9);
  assert.ok(slow.rates.every((rate) => rate === 1), '慢 tempo 的原调颗粒仍为 1× pitch');
  assert.ok(fast.rates.every((rate) => rate === 1), '快 tempo 的原调颗粒仍为 1× pitch');
});

test('texture Jungle 同一日同一步只发一枚 slice，避免多音高相位叠加', async () => {
  await withEngine(async ({ world, context }) => {
    world.emit('perch', {
      treeId: 'texture', birdId: 60, branchId: 1, pitchBranchId: 1,
      stepIndex: 4, day: 2, perchedOnBranch: 1,
    });
    const oneSliceGrains = context.bufferSources.length;
    world.emit('perch', {
      treeId: 'texture', birdId: 61, branchId: 3, pitchBranchId: 3,
      stepIndex: 4, day: 2, perchedOnBranch: 1,
    });
    assert.equal(context.bufferSources.length, oneSliceGrains, '同拍第二音高不生成颗粒');
    world.emit('perch', {
      treeId: 'texture', birdId: 62, branchId: 3, pitchBranchId: 3,
      stepIndex: 5, day: 2, perchedOnBranch: 1,
    });
    assert.equal(context.bufferSources.length, oneSliceGrains * 2,
      '同拍第二音高被抑制，下一整拍正常发声');
  });
});

test('Jungle 句尾 Agent edit：repeat/dropout/filter/crush/dub 均在单步边界内', async () => {
  await withEngine(async ({ world, context }) => {
    world.emit('perch', {
      treeId: 'texture', birdId: 70, branchId: 2, pitchBranchId: 2,
      stepIndex: 15, day: 2, perchedOnBranch: 1,
      jungleEditPlan: { breakEdit: 'repeat4', toneEdit: 'filter' },
    });
    const repeatSources = context.bufferSources.length;
    assert.ok(repeatSources > 8, 'repeat4 在原一步内重触发四段');
    assert.ok(context.filters.some((node) => node.type === 'bandpass'));
    assert.ok(Math.abs(Math.max(...context.bufferSources.map((source) => source.stopped[0])) - 0.5) < 1e-9);

    world.emit('perch', {
      treeId: 'texture', birdId: 71, branchId: 2, pitchBranchId: 2,
      stepIndex: 15, day: 3, perchedOnBranch: 1,
      jungleEditPlan: { breakEdit: 'dropout', toneEdit: 'clean' },
    });
    assert.equal(context.bufferSources.length, repeatSources, 'dropout 不生成伪静音 source');

    world.emit('perch', {
      treeId: 'texture', birdId: 72, branchId: 2, pitchBranchId: 2,
      stepIndex: 15, day: 4, perchedOnBranch: 1,
      jungleEditPlan: { breakEdit: 'hold', toneEdit: 'crush' },
    });
    world.emit('perch', {
      treeId: 'texture', birdId: 73, branchId: 2, pitchBranchId: 2,
      stepIndex: 15, day: 5, perchedOnBranch: 1,
      jungleEditPlan: { breakEdit: 'hold', toneEdit: 'dub' },
    });
    assert.ok(context.shapers.length > 0);
    assert.ok(context.delays.length > 0);
  });
});

test('D1 pad：慢速滤波/失谐 LFO 已挂接；基频固定（不改 voicing 落位）', async () => {
  await withEngine(async ({ world, context }) => {
    world.emit('perch', { treeId: 'pad', birdId: 7, branchId: 2, perchedOnBranch: 1 });
    const pad = CONFIG.audio.timbres.pad;
    const tone0 = context.oscillators[0];
    const baseFreq = tone0.frequency.value;
    assert.equal(tone0.frequency.events.length, 0, '基频无自动化曲线——调制只走 detune/滤波');
    assert.ok(context.oscillators.some((osc) => osc.frequency.value === pad.filterModHz),
      '滤波扫 LFO 存在');
    assert.ok(context.oscillators.some((osc) => osc.frequency.value === pad.detuneModHz),
      '微失谐漂移 LFO 存在');
    assert.ok(context.filters.some((f) => f.type === 'lowpass'
      && Math.abs(f.frequency.value - pad.filterModBaseHz) < 1e-6),
      '慢扫低通以 filterModBaseHz 为中心');
    // 同枝第二只鸟：同基频（音频层不补写和弦角色）
    world.emit('perch', { treeId: 'pad', birdId: 8, branchId: 2, perchedOnBranch: 2 });
    const { partials, detuneCents, filterModHz, detuneModHz, chorus } = pad;
    const perVoice = partials.length * detuneCents.length + 1
      + (filterModHz > 0 ? 1 : 0) + (detuneModHz > 0 ? 1 : 0) + chorus.delaySeconds.length;
    const root1 = context.oscillators[0].frequency.value;
    const root2 = context.oscillators[perVoice].frequency.value;
    assert.equal(Math.round(root1), Math.round(root2), '同枝两鸟同基频——未硬加分解和弦');
    assert.equal(root1, baseFreq);
  });
});

test('混响发送量按声部分配：pad 最湿，bass/texture 接近干', () => {
  const send = (species) => CONFIG.audio.timbres[species].reverbSend;
  assert.ok(send('pad') > send('melody'));
  assert.ok(send('melody') > send('texture'));
  assert.ok(send('texture') >= send('bass'));
  assert.ok(send('bass') <= 0.05, 'bass 几乎无混响');
});

test('森林环境声循环铺底；暂停只淡出乐器并抬起环境声', async () => {
  await withEngine(async ({ engine, context }) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(engine.getAmbienceState().status, 'ready');
    assert.match(engine.getAmbienceState().url, /forest-soundreality-537925\.mp3$/);
    const ambience = context.bufferSources.find((source) => source.loop === true);
    assert.ok(ambience, '五分钟森林录音应作为循环 AudioBufferSource 启动');
    engine.setPaused(true);
    assert.equal(engine.getAmbienceState().paused, true);
    assert.ok(context.gains.some((gain) => gain.gain.events.some((event) => event[0] === 'target' && event[1] === 0)),
      '暂停淡出乐器混音总线');
    assert.ok(context.gains.some((gain) => gain.gain.events.some((event) => event[0] === 'target' && event[1] === 0.22)),
      '暂停时环境声缓慢抬起');
  });
});

test('晨鸣已摘除：dawn 不再触发任何发声节点', async () => {
  await withEngine(async ({ world, context }) => {
    const before = { osc: context.oscillators.length, noise: context.bufferSources.length };
    world.emit('dawn', { day: 2, chord: 'F' });
    assert.equal(context.oscillators.length, before.osc, 'dawn 无新增振荡器');
    assert.equal(context.bufferSources.length, before.noise, 'dawn 无新增噪声源');
  });
});

test('setTempo 后 bass 脉冲按新 BPM 重算拍对齐（不沿用旧 offset）', async () => {
  await withEngine(async ({ world, context }) => {
    world.emit('perch', { treeId: 'bass', birdId: 40, branchId: 0, perchedOnBranch: 1 });
    const triangles = () => context.oscillators.filter((osc) => osc.type === 'triangle');
    assert.deepEqual(triangles().slice(0, 4).map((osc) => osc.started[0]), [0, 0.5, 1, 1.5], '120 BPM 每拍 0.5s');
    const beforeCount = context.oscillators.length;
    assert.equal(world.setTempo(60), true);
    const after = context.oscillators.slice(beforeCount).filter((osc) => osc.type === 'triangle')
      .slice(0, 4).map((osc) => osc.started[0]);
    assert.deepEqual(after, [0, 1, 2, 3], '60 BPM 重排后每拍 1s，相对拍网格重新对齐');
  }, { tension: 0.2, bpm: 120, chord: { notes: [48, 55, 60, 64, 67] } });
});

test('granularPlan 对非有限 tension 回落 0（与引擎路径一致）', () => {
  assert.equal(granularPlan({ tension: Number.NaN, seed: 1 }).length, 5);
  assert.equal(granularPlan({ tension: Infinity, seed: 1 }).length, 5);
});

test('setParam：右侧六项统一写入每声部总线', async () => {
  const { MIX_PARAM_SPECS: specs } = await import('../src/audio.js');
  assert.equal(specs.common.length, 6);
  assert.equal(specs.bass.length, 0);
  const original = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  try {
    const config = structuredClone(CONFIG);
    const world = fakeWorld();
    const engine = createAudioEngine({
      config,
      getChord: () => ({ notes: [48, 52, 55, 60, 64] }),
      getFrame: () => ({ tension: 0.2 }),
    });
    engine.attach(world);
    await engine.start();
    assert.equal(engine.setParam('pad', 'gain', 1.5), true);
    assert.equal(config.audio.timbres.pad.gain, 1.5);
    assert.equal(engine.setParam('pad', 'eqLowDb', -6), true);
    assert.equal(config.audio.timbres.pad.eqLowDb, -6);
    assert.equal(engine.setParam('pad', 'reverbSend', 0.2), true);
    assert.equal(config.audio.timbres.pad.reverbSend, 0.2);
    assert.equal(engine.setParam('pad', 'pingPongSend', 0.3), true);
    assert.equal(config.audio.timbres.pad.pingPongSend, 0.3);
    assert.equal(engine.setParam('pad', 'attackSeconds', 0.8), false, '内部音色细项不再暴露为通用滑杆');
    assert.equal(engine.getVoiceMode('texture'), 'jungle');
    assert.equal(engine.setVoiceMode('texture', 'texture'), true);
    assert.equal(engine.getVoiceMode('texture'), 'texture');
    assert.equal(engine.setVoiceMode('texture', 'invalid'), false);
    assert.equal(engine.setParam('pad', 'nope', 1), false);
    // 越界夹取
    engine.setParam('pad', 'eqHighDb', 99);
    assert.equal(config.audio.timbres.pad.eqHighDb, 12);
    const ctx = FakeAudioContext.latest;
    const shelves = ctx.filters.filter((f) => f.type === 'lowshelf' || f.type === 'highshelf' || f.type === 'peaking');
    assert.ok(shelves.length >= 3, '应创建用户搁架/峰值 EQ 节点');
    engine.setZoomFocus('pad');
    engine.setZoomFocus(null);
  } finally {
    globalThis.AudioContext = original;
  }
});

test('mute/solo：播放层 gate，不改 timbre.gain；solo 互斥静音其它声部', async () => {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  try {
    const config = structuredClone(CONFIG);
    const world = fakeWorld();
    const engine = createAudioEngine({
      config,
      getChord: () => ({ notes: [48, 52, 55, 60, 64] }),
      getFrame: () => ({ tension: 0.2 }),
    });
    engine.attach(world);
    await engine.start();
    const ctx = FakeAudioContext.latest;
    const dryFilter = ctx.filters.find((node) => node.type === 'lowpass');
    assert.ok(dryFilter, '应有昼夜宏 lowpass');
    const gates = ctx.gains.filter((g) => g.gain.value === 1 && g.connections.includes(dryFilter));
    assert.equal(gates.length, 4, '四声部各一个 mute/solo gate → filter');

    const padGainBefore = config.audio.timbres.pad.gain;
    assert.equal(engine.setMute('pad', true), true);
    assert.deepEqual(engine.getMuteSolo().mute.pad, true);
    assert.equal(config.audio.timbres.pad.gain, padGainBefore, 'mute 不得改写 timbre.gain');
    assert.ok(gates.some((g) => g.gain.events.some((e) => e[0] === 'target' && e[1] === 0)),
      'mute 应将某 gate 目标设为 0');

    assert.equal(engine.setMute('pad', false), true);
    assert.equal(engine.setSolo('melody', true), true);
    assert.equal(engine.getMuteSolo().solo.melody, true);
    // 未 solo 的声部 gate → 0；melody 保持 1
    const zeroTargets = gates.filter((g) => g.gain.events.some((e) => e[0] === 'target' && e[1] === 0));
    assert.ok(zeroTargets.length >= 3, 'solo 时应压掉其它声部');
    assert.equal(engine.setSolo('bass', true), true);
    assert.equal(engine.getMuteSolo().solo.bass, true);
    assert.equal(engine.getMuteSolo().solo.melody, false, '切换轨道 Solo 应互斥，不残留隐藏状态');
    assert.equal(engine.setSolo('bass', false), true);
    assert.equal(Object.values(engine.getMuteSolo().solo).some(Boolean), false);
    assert.equal(engine.setSolo('nope', true), false);
  } finally {
    globalThis.AudioContext = original;
  }
});
