import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bassArpPlan, createAudioEngine, granularPlan, melodyPhrasePlan } from '../src/audio.js';
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
  constructor() { super(); this.buffer = null; this.started = []; this.stopped = []; }
  start(time) { this.started.push(time); }
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
  async resume() { this.state = 'running'; }
}

function fakeWorld({ bpm = 120, phase = 0 } = {}) {
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

async function withEngine(run, { tension = 0.2, bpm = 120, phase = 0,
  chord = { notes: [48, 52, 55, 60, 64] } } = {}) {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
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
  }
}

test('四物种按 engine/polyphonic 数据路由，pad 为 additive sine 持续音', async () => {
  await withEngine(async ({ engine, world, context }) => {
    const voices = engine.describeVoices();
    assert.deepEqual(Object.keys(voices), ['pad', 'melody', 'bass', 'texture']);
    assert.deepEqual(Object.fromEntries(Object.entries(voices).map(([id, voice]) => [id, voice.engine])), {
      pad: 'sustained', melody: 'sineWhistle', bass: 'triangleArp', texture: 'granular',
    });
    world.emit('perch', { treeId: 'pad', birdId: 1, branchId: 2, perchedOnBranch: 1 });
    const { partials, breatheHz } = CONFIG.audio.timbres.pad;
    assert.equal(context.oscillators.length, partials.length + 1, 'pad = 泛音簇每泛音一 osc + 呼吸 LFO');
    const base = context.oscillators[0].frequency.value / partials[0][0];
    for (let index = 0; index < partials.length; index += 1) {
      assert.equal(context.oscillators[index].type, 'sine', '泛音簇全部为正弦');
      assert.ok(Math.abs(context.oscillators[index].frequency.value - base * partials[index][0]) < 1e-9,
        `泛音 ${index} 按频率比 ${partials[index][0]} 叠加`);
    }
    const lfo = context.oscillators[partials.length];
    assert.equal(lfo.frequency.value, breatheHz, '呼吸调幅 LFO 频率');
    assert.ok(Array.isArray(lfo.connections[0]?.connections[0]?.events),
      '呼吸 LFO 经深度增益挂到包络 gain AudioParam');
    assert.ok(context.filters.some((f) => f.type === 'highpass' && f.frequency.value === 180),
      'pad 高通 180Hz 给 bass 让位');
  });
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
    assert.ok(firstHigh.connections.includes(dryFilter), '干声主干 high→filter 直通');
    assert.ok(firstHigh.connections.includes(context.analysers[0]), 'high 另分支到 analyser tap');
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

test('bass 三角波纯音：tanh 软饱和 + 420Hz 低通，1-5-8-5 按拍循环', async () => {
  const pure = bassArpPlan({
    chordNotes: [48, 55, 60, 64, 67], registerOffset: -12, skeletonBranches: 3,
    pattern: [0, 1, 2, 1], bpm: 120, phase: 0, barsPerDay: 4, beatsPerBar: 4, tension: 0.2,
  });
  assert.deepEqual(pure.slice(0, 4).map((note) => note.midi), [36, 43, 48, 43]);
  assert.deepEqual(pure.slice(0, 4).map((note) => note.offsetSeconds), [0, 0.5, 1, 1.5]);

  await withEngine(async ({ world, context }) => {
    world.emit('perch', { treeId: 'bass', birdId: 20, branchId: 0, perchedOnBranch: 1 });
    assert.equal(context.delays.length, 0, '三角波琶音不使用延迟线');
    assert.equal(context.bufferSources.length, 0, '三角波琶音不使用噪声激励');
    const triangles = context.oscillators.filter((osc) => osc.type === 'triangle');
    const sines = context.oscillators.filter((osc) => osc.type === 'sine');
    assert.equal(triangles.length, 16, '低 tension 每拍一音，一昼夜 16 拍');
    assert.equal(sines.length, 16, '每音饱和前混入一个基波正弦');
    assert.deepEqual(triangles.slice(0, 4).map((osc) => osc.started[0]), [0, 0.5, 1, 1.5]);
    assert.ok(Math.abs(triangles[0].frequency.value - midiToFrequency(36)) < 1e-9,
      '三角波按枝映射后的低音频率发声');
    assert.ok(Math.abs(sines[0].frequency.value - triangles[0].frequency.value) < 1e-9,
      '基波正弦与三角波同频');
    assert.ok(context.gains.some((node) => node.gain.value === CONFIG.audio.timbres.bass.subSineMix),
      '基波正弦按 subSineMix 比例混入');
    assert.equal(context.shapers.length, 16, '每音一个 tanh 软饱和 WaveShaper');
    assert.ok(context.shapers.every((node) => node.curve?.length > 0
      && node.oversample === CONFIG.audio.saturationOversample), '饱和曲线与过采样生效');
    const { attackSeconds, noteSeconds, releaseSeconds, decayTauSeconds } = CONFIG.audio.timbres.bass;
    const sustainValue = Math.exp(-(noteSeconds - attackSeconds) / decayTauSeconds);
    const env = context.gains.find((node) => node.gain.events.length === 4
      && node.gain.events[0][0] === 'set' && node.gain.events[0][1] === 0
      && node.gain.events[1][0] === 'linear' && node.gain.events[1][1] === 1);
    assert.ok(env, '每音一个起音/衰减/释放包络');
    assert.ok(Math.abs(env.gain.events[1][2] - attackSeconds) < 1e-9, '12ms 起音');
    assert.ok(Math.abs(env.gain.events[2][1] - sustainValue) < 1e-6
      && Math.abs(env.gain.events[2][2] - noteSeconds) < 1e-9, '主体内 exp(-t/τ) 指数衰减');
    assert.ok(Math.abs(env.gain.events[3][1] - 0.001) < 1e-12
      && Math.abs(env.gain.events[3][2] - (noteSeconds + releaseSeconds)) < 1e-9, '短释放归零');
    assert.ok(context.filters.some((f) => f.type === 'lowpass' && f.frequency.value === 420),
      '420Hz 低通收暗');
    assert.ok(context.filters.some((f) => f.type === 'highpass' && f.frequency.value === 50));
    world.emit('unperch', { treeId: 'bass', birdId: 20, branchId: 0, dwellTime: 2 });
    assert.ok(context.oscillators.every((osc) => osc.stopped.length >= 2), '最后一只离枝立即静音已排 arp');
  }, { tension: 0.2, chord: { notes: [48, 55, 60, 64, 67] } });

  await withEngine(async ({ world, context }) => {
    world.emit('perch', { treeId: 'bass', birdId: 21, branchId: 0, perchedOnBranch: 1 });
    const triangles = context.oscillators.filter((osc) => osc.type === 'triangle');
    assert.equal(triangles.length, 32, '高 tension 每半拍一音');
    assert.deepEqual(triangles.slice(0, 4).map((osc) => osc.started[0]), [0, 0.25, 0.5, 0.75]);
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

test('texture granular：每次落枝 5–12 粒，粒长/时距/带通微移且数量随 tension', async () => {
  const lowPlan = granularPlan({ tension: 0, seed: 1 });
  const highPlan = granularPlan({ tension: 1, seed: 1 });
  assert.equal(lowPlan.length, 5);
  assert.equal(highPlan.length, 12);
  assert.ok(highPlan.every((grain) => grain.durationSeconds >= 0.01 && grain.durationSeconds <= 0.04));
  assert.ok(highPlan.every((grain) => grain.centerHz >= 2500 && grain.centerHz <= 6000));

  await withEngine(async ({ world, context }) => {
    world.emit('perch', { treeId: 'texture', birdId: 30, branchId: 0, perchedOnBranch: 1 });
    assert.equal(context.bufferSources.length, 5, '低 tension 生成 5 粒');
    const bands = context.filters.filter((node) => node.type === 'bandpass');
    assert.equal(bands.length, 5);
    assert.ok(new Set(bands.map((node) => Math.round(node.frequency.value))).size > 1, '每粒带通中心独立微移');
  }, { tension: 0 });
  await withEngine(async ({ world, context }) => {
    world.emit('perch', { treeId: 'texture', birdId: 31, branchId: 0, perchedOnBranch: 1 });
    assert.equal(context.bufferSources.length, 12, '高 tension 生成 12 粒');
    const starts = context.bufferSources.map((source) => source.started[0]);
    assert.ok(starts.slice(1).every((at, index) => at > starts[index]), '粒间随机时距严格递增');
  }, { tension: 1 });
});

test('混响发送量按声部分配：pad 最湿，bass/texture 接近干', () => {
  const send = (species) => CONFIG.audio.timbres[species].reverbSend;
  assert.ok(send('pad') > send('melody'));
  assert.ok(send('melody') > send('texture'));
  assert.ok(send('texture') >= send('bass'));
  assert.ok(send('bass') <= 0.05, 'bass 几乎无混响');
});

test('晨鸣已摘除：dawn 不再触发任何发声节点', async () => {
  await withEngine(async ({ world, context }) => {
    const before = { osc: context.oscillators.length, noise: context.bufferSources.length };
    world.emit('dawn', { day: 2, chord: 'F' });
    assert.equal(context.oscillators.length, before.osc, 'dawn 无新增振荡器');
    assert.equal(context.bufferSources.length, before.noise, 'dawn 无新增噪声源');
  });
});

test('setTempo 后 bass arp 按新 BPM 重算拍对齐（不沿用旧 offset）', async () => {
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

test('setParam：通用三控写声部总线，特有参数写 timbre（R3）', async () => {
  const { MIX_PARAM_SPECS: specs } = await import('../src/audio.js');
  assert.ok(specs.common.length >= 5);
  assert.equal(specs.bass[0].key, 'arpDensityMax');
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
    assert.equal(engine.setParam('pad', 'attackSeconds', 0.8), true);
    assert.equal(config.audio.timbres.pad.attackSeconds, 0.8);
    assert.equal(engine.setParam('bass', 'arpDensityMax', 0.25), true);
    assert.equal(config.audio.timbres.bass.arpDensityMax, 0.25);
    assert.equal(engine.setParam('texture', 'grainCountMax', 7), true);
    assert.equal(config.audio.timbres.texture.grainCountMax, 7);
    assert.equal(engine.setParam('melody', 'phraseMaxNotes', 6), true);
    assert.equal(config.audio.timbres.melody.phraseMaxNotes, 6);
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
