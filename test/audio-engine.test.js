import assert from 'node:assert/strict';
import test from 'node:test';
import { PerceptualWebAudioEngine } from '../src/audio-engine.js';

test('synth engine starts offline and reports web-audio-synth when running', () => {
  const engine = new PerceptualWebAudioEngine();
  assert.equal(engine.mode, 'offline');
  assert.equal(engine.running, false);
  engine.mode = 'web-audio-synth';
  engine.context = { state: 'running', currentTime: 0 };
  assert.equal(engine.running, true);
  assert.match(engine.label, /Web Audio 轻量合成器/);
});

test('mute and solo states remain explicit voice controls', () => {
  const engine = new PerceptualWebAudioEngine();
  assert.equal(engine.setVoiceMuted(2, true), true);
  assert.equal(engine.setVoiceSolo(1, true), true);
  const diagnostics = engine.getVoiceDiagnostics();
  assert.equal(diagnostics.length, 3);
  assert.equal(diagnostics[2].muted, true);
  assert.equal(diagnostics[1].solo, true);
});

test('transport and pattern drive client-side scheduling', () => {
  const engine = new PerceptualWebAudioEngine();
  engine.context = { currentTime: 10, state: 'running' };
  engine.setTransport({ bpm: 120, beatsPerBar: 4, loopBars: 1, playing: true });
  engine.clientTransport.startTime = 8; // 2 秒前启动 = 4 拍（120bpm）
  const transport = engine.getTransportState();
  assert.equal(transport.beat, 0); // 4 拍整，loop 回卷到 0
  assert.equal(transport.loopBeats, 4);
  engine.setPattern(0, [{ beat: 0, midi: 60, durBeats: 1, vel: 0.9 }]);
  assert.equal(engine.patterns.get(0).length, 1);
  engine.setChord(50, 'major');
  assert.equal(engine.chord.rootMidi, 50);
});

test('master macros and eco overrides are accepted without a context', () => {
  const engine = new PerceptualWebAudioEngine();
  engine.setMasterMacros({ brightness: 0.6, lofiMix: 0.3, filterMacro: 0.8 }); // 无 context 时不抛
  engine.setVoiceOverride(0, { relationState: [0, 0, 0, 0, 0, 0, 0, 0], eco: { richness: { reverbSend: 0.3, harmonicGain: 0.5 }, impurity: { noiseMix: 0.1, detuneCents: 10 } }, focusGain: 0.4 });
  assert.equal(engine.voiceOverrides.get(0).focusGain, 0.4);
});
