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
  let currentBpm = bpm;
  const world = {
    on(type, listener) { listeners.set(type, listener); },
    emit(type, event) { listeners.get(type)?.(event); },
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

test('四物种按 engine/polyphonic 数据路由，pad 保留 v2 持续音', async () => {
  await withEngine(async ({ engine, world, context }) => {
    const voices = engine.describeVoices();
    assert.deepEqual(Object.keys(voices), ['pad', 'melody', 'bass', 'texture']);
    assert.deepEqual(Object.fromEntries(Object.entries(voices).map(([id, voice]) => [id, voice.engine])), {
      pad: 'sustained', melody: 'fmPhrase', bass: 'karplusArp', texture: 'granular',
    });
    world.emit('perch', { treeId: 'pad', birdId: 1, branchId: 2, perchedOnBranch: 1 });
    assert.equal(context.oscillators.length, 3, 'pad = saw 主音 + 失谐 saw + 低八度 sub');
    assert.equal(context.oscillators[1].detune.value, CONFIG.audio.timbres.pad.detuneCents);
    assert.ok(context.filters.some((f) => f.type === 'highpass' && f.frequency.value === 180),
      'pad 高通 180Hz 给 bass 让位');
  });
});

test('bass Karplus-Strong：delay→低通→feedback→delay，1-5-8-5 按拍循环', async () => {
  const pure = bassArpPlan({
    chordNotes: [48, 55, 60, 64, 67], registerOffset: -12, skeletonBranches: 3,
    pattern: [0, 1, 2, 1], bpm: 120, phase: 0, barsPerDay: 4, beatsPerBar: 4, tension: 0.2,
  });
  assert.deepEqual(pure.slice(0, 4).map((note) => note.midi), [36, 43, 48, 43]);
  assert.deepEqual(pure.slice(0, 4).map((note) => note.offsetSeconds), [0, 0.5, 1, 1.5]);

  await withEngine(async ({ world, context }) => {
    world.emit('perch', { treeId: 'bass', birdId: 20, branchId: 0, perchedOnBranch: 1 });
    assert.equal(context.oscillators.length, 0, 'KS 不使用周期振荡器');
    assert.equal(context.delays.length, 16, '低 tension 每拍一音，一昼夜 16 拍');
    assert.equal(context.bufferSources.length, 16, '每个拨弦音一个短噪声激励');
    assert.deepEqual(context.bufferSources.slice(0, 4).map((source) => source.started[0]), [0, 0.5, 1, 1.5]);
    assert.ok(Math.abs(context.delays[0].delayTime.value - 1 / midiToFrequency(36)) < 1e-9,
      '延迟线长度按枝映射后的低音频率取倒数');
    const damping = context.delays[0].connections.find((node) => node.type === 'lowpass');
    const feedback = damping.connections[0];
    assert.deepEqual(feedback.gain.events.slice(0, 2), [
      ['set', CONFIG.audio.timbres.bass.feedback, 0],
      ['exponential', 0.001, CONFIG.audio.timbres.bass.noteDecaySeconds],
    ], 'KS 反馈环按单音衰减并显式归零');
    assert.equal(feedback.connections[0], context.delays[0], '反馈低通闭环回 delay');
    assert.ok(context.filters.some((f) => f.type === 'lowpass' && f.frequency.value === 300));
    world.emit('unperch', { treeId: 'bass', birdId: 20, branchId: 0, dwellTime: 2 });
    assert.ok(context.bufferSources.every((source) => source.stopped.length >= 2), '最后一只离枝立即静音已排 arp');
  }, { tension: 0.2, chord: { notes: [48, 55, 60, 64, 67] } });

  await withEngine(async ({ world, context }) => {
    world.emit('perch', { treeId: 'bass', birdId: 21, branchId: 0, perchedOnBranch: 1 });
    assert.equal(context.delays.length, 32, '高 tension 每半拍一音');
    assert.deepEqual(context.bufferSources.slice(0, 4).map((source) => source.started[0]), [0, 0.25, 0.5, 0.75]);
  }, { tension: 0.9, chord: { notes: [48, 55, 60, 64, 67] } });
});

test('melody FM：框架内 2–4 音级进到目标枝，调制比/index 衰减与尾音颤音生效', async () => {
  const phrase = melodyPhrasePlan({ targetMidi: 67, chordNotes: [60, 64, 67, 72, 76], seed: 44 });
  assert.ok(phrase.length >= 2 && phrase.length <= 4);
  assert.equal(phrase.at(-1).midi, 67, '短句末音必须落到目标枝音');
  assert.ok(phrase.every((note, index) => index === 0
    || Math.abs([60, 64, 67, 72, 76].indexOf(note.midi) - [60, 64, 67, 72, 76].indexOf(phrase[index - 1].midi)) === 1),
  '短句只在框架内相邻音级级进');

  await withEngine(async ({ world, context }) => {
    world.emit('perch', { treeId: 'melody', birdId: 10, branchId: 2, perchedOnBranch: 1 });
    assert.equal(context.oscillators.length, phrase.length * 3, '每音 = carrier + modulator + vibrato LFO');
    for (let index = 0; index < phrase.length; index += 1) {
      const [carrier, modulator, vibrato] = context.oscillators.slice(index * 3, index * 3 + 3);
      assert.equal(modulator.frequency.value / carrier.frequency.value, CONFIG.audio.timbres.melody.fmRatio);
      assert.equal(modulator.connections[0].connections[0], carrier.frequency, 'modulator 经 index gain 调 carrier.frequency');
      assert.equal(modulator.connections[0].gain.events[0][1],
        carrier.frequency.value * CONFIG.audio.timbres.melody.fmIndex);
      assert.equal(vibrato.frequency.value, CONFIG.audio.timbres.melody.vibratoHz);
      assert.equal(vibrato.connections[0].connections[0], carrier.detune, 'vibrato 只调载波 detune');
    }
    const carriers = context.oscillators.filter((_osc, index) => index % 3 === 0);
    assert.equal(carriers.at(-1).frequency.value,
      midiToFrequency(67 + CONFIG.audio.timbres.melody.outputOctave));
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
    const at120 = context.bufferSources.slice(0, 4).map((source) => source.started[0]);
    assert.deepEqual(at120, [0, 0.5, 1, 1.5], '120 BPM 每拍 0.5s');
    const beforeCount = context.bufferSources.length;
    assert.equal(world.setTempo(60), true);
    const after = context.bufferSources.slice(beforeCount, beforeCount + 4)
      .map((source) => source.started[0]);
    assert.deepEqual(after, [0, 1, 2, 3], '60 BPM 重排后每拍 1s，相对拍网格重新对齐');
  }, { tension: 0.2, bpm: 120, chord: { notes: [48, 55, 60, 64, 67] } });
});

test('granularPlan 对非有限 tension 回落 0（与引擎路径一致）', () => {
  assert.equal(granularPlan({ tension: Number.NaN, seed: 1 }).length, 5);
  assert.equal(granularPlan({ tension: Infinity, seed: 1 }).length, 5);
});
