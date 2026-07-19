import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioEngine } from '../src/audio.js';
import { CONFIG } from '../src/config.js';
import { midiToFrequency } from '../src/mapping.js';

class FakeParam {
  constructor(value = 0) { this.value = value; }
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
  exponentialRampToValueAtTime(value) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
  cancelScheduledValues() {}
}

class FakeNode {
  constructor() { this.connections = []; }
  connect(node) { this.connections.push(node); return node; }
}

class FakeOscillator extends FakeNode {
  constructor() {
    super();
    this.frequency = new FakeParam();
    this.started = [];
    this.stopped = [];
  }
  start(time) { this.started.push(time); }
  stop(time) { this.stopped.push(time); }
}

class FakeAudioContext {
  static latest = null;
  constructor() {
    this.currentTime = 0;
    this.state = 'suspended';
    this.destination = new FakeNode();
    this.oscillators = [];
    FakeAudioContext.latest = this;
  }
  createGain() { const node = new FakeNode(); node.gain = new FakeParam(); return node; }
  createBiquadFilter() {
    const node = new FakeNode();
    node.frequency = new FakeParam();
    node.Q = new FakeParam();
    return node;
  }
  createOscillator() {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
  async resume() { this.state = 'running'; }
}

function fakeWorld() {
  const listeners = new Map();
  return {
    on(type, listener) { listeners.set(type, listener); },
    emit(type, event) { listeners.get(type)?.(event); },
    getSnapshot() { return { daylight: 1, birds: [] }; },
  };
}

test('四物种音色齐全，按 species/polyphonic 路由 bass 长音与 texture 重复触发', async () => {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  try {
    const world = fakeWorld();
    const engine = createAudioEngine({
      config: CONFIG,
      getChord: () => ({ notes: [48, 52, 55, 60, 64] }),
    });
    assert.deepEqual(Object.keys(engine.describeVoices()), ['pad', 'melody', 'bass', 'texture']);
    await engine.start();
    engine.attach(world);

    world.emit('perch', { treeId: 'bass', birdId: 20, branchId: 0, perchedOnBranch: 1 });
    const context = FakeAudioContext.latest;
    assert.equal(context.oscillators.length, 2, 'bass = saw 主音 + 低八度 sub');
    assert.equal(context.oscillators[0].type, CONFIG.audio.timbres.bass.oscType);
    assert.ok(Math.abs(context.oscillators[0].frequency.value - midiToFrequency(36)) < 1e-9,
      'bass registerOffset=-12 生效');

    world.emit('perch', { treeId: 'texture', birdId: 30, branchId: 0, perchedOnBranch: 1 });
    const textureOscillators = context.oscillators.slice(2);
    assert.equal(textureOscillators.length, CONFIG.audio.timbres.texture.repeatCount);
    assert.ok(textureOscillators.every((oscillator) => oscillator.type === CONFIG.audio.timbres.texture.oscType));
    assert.ok(Math.abs(textureOscillators[0].frequency.value - midiToFrequency(55)) < 1e-9,
      'texture registerOffset=+7 生效');

    world.emit('unperch', { treeId: 'bass', birdId: 20, branchId: 0, dwellTime: 2 });
    assert.ok(context.oscillators.slice(0, 2).every((oscillator) => oscillator.stopped.length === 1));
  } finally {
    if (original === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = original;
  }
});
