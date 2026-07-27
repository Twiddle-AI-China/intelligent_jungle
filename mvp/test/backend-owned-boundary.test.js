import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);

test('candidate latent view cannot reach browser-owned runtime or worker internals', async () => {
  const source = await readFile(new URL('mvp/src/ui/latent-roamer.js', ROOT), 'utf8');
  for (const forbidden of [
    'agent.js', 'llm/', 'audio.js', 'ecological-latent.js', '/api/decoder-status',
    'voice_maps/', 'timbreXY', 'timbrePCA', 'stepfunBase', '8081',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.equal(source.includes('runtimeClient.command'), true);
  assert.equal(source.includes('fetch('), false);
});

test('candidate fixtures remain absent from every production entry and manifest', async () => {
  const html = await readFile(new URL('mvp/index.html', ROOT), 'utf8');
  const manifest = await readFile(new URL(
    'docs/production-manifests/2026-07-22-production.json', ROOT,
  ), 'utf8');
  assert.equal(html.includes('candidate-ui'), false);
  assert.equal(manifest.includes('candidate-ui'), false);
  assert.equal(existsSync(new URL('flock-voice-engine/web/test/fixtures/candidate-ui', ROOT)), false);
  assert.equal(existsSync(new URL('mvp/candidate-runtime.html', ROOT)), false);
  assert.equal(existsSync(new URL('mvp/src/candidate-main.js', ROOT)), false);
});
