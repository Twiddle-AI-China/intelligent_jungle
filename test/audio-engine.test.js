import assert from 'node:assert/strict';
import test from 'node:test';
import { PerceptualWebAudioEngine } from '../src/audio-engine.js';

test('audio engine reports realtime decoder as the only successful live mode', () => {
  const engine = new PerceptualWebAudioEngine();
  assert.equal(engine.facts.liveDecoder, false);
  assert.equal(engine.facts.latentControlDimensions, 4);
  assert.equal(engine.running, false);
  engine.mode = 'brave-realtime';
  engine.modelSha = '36ca2bd1f3b3';
  assert.match(engine.label, /BRAVE 实时 decoder/);
  assert.equal(engine.facts.liveDecoder, true);
});

test('mute and solo states remain explicit decoder controls', () => {
  const engine = new PerceptualWebAudioEngine();
  assert.equal(engine.setVoiceMuted(2, true), true);
  assert.equal(engine.setVoiceSolo(1, true), true);
  const diagnostics = engine.getVoiceDiagnostics();
  assert.equal(diagnostics.length, 3);
  assert.equal(diagnostics[2].muted, true);
  assert.equal(diagnostics[1].solo, true);
});
