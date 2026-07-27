import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../../../', import.meta.url);

test('Phase 3-4 candidate graph contains no provider, audio, or map-internal capability', async () => {
  const files = [
    'mvp/src/ui/latent-roamer.js',
    'flock-voice-engine/runtime/test/fixtures/candidate-ui/candidate-main.js',
  ];
  const source = (await Promise.all(files.map((path) => readFile(new URL(path, ROOT), 'utf8')))).join('\n');
  for (const forbidden of [
    'Authorization', 'apiKey', 'prompt', 'chat/completions', 'AudioContext',
    'AudioWorklet', '/decoder', '/api/v1/audio', 'voice_maps/', 'stepfunBase',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

test('public latent contracts omit identity, token, and worker internals', async () => {
  const sources = await Promise.all([
    'flock-voice-engine/runtime/src/latent/map-repository.js',
    'flock-voice-engine/runtime/src/latent/latent-runtime.js',
    'flock-voice-engine/runtime/src/latent/preview-lease.js',
  ].map((path) => readFile(new URL(path, ROOT), 'utf8')));
  const publicProjectors = sources.join('\n');
  assert.match(publicProjectors, /audible:\s*false/);
  assert.match(publicProjectors, /shadow-no-audio/);
  const browser = await readFile(new URL('mvp/src/ui/latent-roamer.js', ROOT), 'utf8');
  for (const forbidden of ['connectionGeneration', 'assetRoot', 'checkpointStep', '.basis', '.z[']) {
    assert.equal(browser.includes(forbidden), false, forbidden);
  }
});
