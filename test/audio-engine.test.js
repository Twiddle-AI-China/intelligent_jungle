import assert from 'node:assert/strict';
import test from 'node:test';
import { PerceptualWebAudioEngine } from '../src/audio-engine.js';

test('audio engine reports realtime decoder as the only successful live mode', () => {
  const engine = new PerceptualWebAudioEngine();
  assert.equal(engine.facts.liveDecoder, false);
  assert.equal(engine.facts.latentControlDimensions, 0);
  assert.equal(engine.running, false);
  engine.mode = 'neural-realtime';
  engine.modelId = 'ensemble';
  engine.models = [{ id: 'brave-16d' }, { id: 'fsl10k-16d' }, { id: 'mrp-8d' }];
  engine.modelSha = '36ca2bd1f3b3';
  assert.match(engine.label, /3 decoders ensemble/);
  assert.equal(engine.facts.liveDecoder, true);
});

test('mute and solo states remain explicit decoder controls', () => {
  const engine = new PerceptualWebAudioEngine();
  engine.models = [{ id: 'brave-16d' }, { id: 'fsl10k-16d' }, { id: 'mrp-8d' }];
  assert.equal(engine.setVoiceMuted(2, true), true);
  assert.equal(engine.setVoiceSolo(1, true), true);
  const diagnostics = engine.getVoiceDiagnostics();
  assert.equal(diagnostics.length, 3);
  assert.equal(diagnostics[2].muted, true);
  assert.equal(diagnostics[1].solo, true);
  assert.deepEqual(diagnostics.map((item) => item.decoderId), ['brave-16d', 'fsl10k-16d', 'mrp-8d']);
  assert.equal(engine.setVoiceDecoder(0, 'mrp-8d'), true);
  assert.equal(engine.getVoiceDiagnostics()[0].decoderId, 'mrp-8d');
});
