import assert from 'node:assert/strict';
import test from 'node:test';
import { XYLatentAudioEngine } from '../src/audio-engine.js';

test('audio engine states the relational timbre and independent keyboard pitch contract truthfully', () => {
  const audio = new XYLatentAudioEngine();
  assert.equal(audio.facts.liveDecoder, false);
  assert.equal(audio.facts.mapping, 'flock-relations-to-real-corpus-atlas');
  assert.equal(audio.modelId, 'fsl10k-16d');
  assert.equal(audio.facts.pitchControl, 'post-decoder-keyboard-semitones');
  assert.equal(audio.facts.gateControl, 'eternal-drone-with-midi-or-computer-keyboard-pitch');
  audio.mode = 'neural-realtime'; audio.latentSize = 16; audio.modelSha = '36ca2bd1f3b3';
  assert.match(audio.label, /flock 8D→real-latent atlas/);
  assert.equal(audio.facts.activeVoices, 1);
});

test('lightweight Web Audio effect controls stay bounded', () => {
  const audio = new XYLatentAudioEngine();
  assert.equal(audio.setEffectControl('delayMix', 9), 0.6);
  assert.equal(audio.setEffectControl('reverbMix', -1), 0);
  assert.equal(audio.setEffectControl('unknown', 1), false);
  assert.equal(audio.setFeatureToggle('pitchShift', false), false);
  assert.equal(audio.facts.pitchControl, 'post-decoder-pitch-bypassed');
  assert.equal(audio.setFeatureToggle('delay', false), false);
  assert.equal(audio.setFeatureToggle('unknown', false), false);
});
