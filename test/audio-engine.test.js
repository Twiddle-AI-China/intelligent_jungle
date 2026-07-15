import assert from 'node:assert/strict';
import test from 'node:test';
import { PerceptualWebAudioEngine } from '../src/audio-engine.js';

test('audio engine reports realtime decoder as the only successful live mode', () => {
  const engine = new PerceptualWebAudioEngine();
  assert.equal(engine.facts.liveDecoder, false);
  assert.equal(engine.facts.latentControlDimensions, 0);
  assert.equal(engine.running, false);
  engine.mode = 'neural-realtime';
  engine.modelId = 'brave-16d';
  engine.latentSize = 16;
  engine.modelSha = '36ca2bd1f3b3';
  assert.match(engine.label, /brave-16d · 16D neural decoder/);
  assert.equal(engine.facts.liveDecoder, true);
  assert.equal(engine.facts.latentControlDimensions, 16);
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
