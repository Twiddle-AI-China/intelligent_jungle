import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CANDIDATE = resolve(
  ROOT,
  'flock-voice-engine/runtime/test/fixtures/candidate-ui',
);

test('candidate UI is test-only, server-read-only, and absent from production artifacts', async () => {
  const html = await readFile(resolve(CANDIDATE, 'index.html'), 'utf8');
  const source = await readFile(resolve(CANDIDATE, 'candidate-main.js'), 'utf8');

  for (const marker of [
    'data-runtime-status',
    'data-world-generation',
    'data-revision',
    'id="world"',
  ]) assert.equal(html.includes(marker), true, marker);
  assert.match(
    html,
    /<script\b[^>]*\btype="module"[^>]*\bsrc="\/flock-voice-engine\/runtime\/test\/fixtures\/candidate-ui\/candidate-main\.js"/,
  );

  assert.match(source, /from '\/mvp\/src\/runtime-client\.js'/);
  assert.match(source, /from '\/mvp\/src\/renderer\.js'/);
  assert.match(source, /from '\/mvp\/src\/ui\/latent-roamer\.js'/);
  assert.match(source, /createRuntimeClient\s*\(/);
  assert.match(source, /createRenderer\s*\(/);
  assert.match(source, /createLatentRoamer\s*\(/);
  assert.match(source, /requestAnimationFrame\s*\(/);
  assert.match(source, /client\.command\s*\(/);
  for (const forbidden of [
    'createWorld',
    'createDeterministicConductor',
    'attachPipelineConductor',
    'agent.js',
    'createAudio',
    'AudioContext',
    'AudioWorklet',
    'ecological-latent.js',
    '/api/v1/audio',
    '/decoder',
    '8081',
  ]) assert.equal(source.includes(forbidden), false, forbidden);

  const manifest = JSON.stringify(JSON.parse(await readFile(
    resolve(ROOT, 'docs/production-manifests/2026-07-22-production.json'),
    'utf8',
  )));
  for (const forbidden of [
    'candidate-ui',
    'flock-voice-engine/runtime/src',
    'mvp/src/runtime-client.js',
  ]) assert.equal(manifest.includes(forbidden), false, forbidden);
  assert.equal(existsSync(resolve(ROOT, 'flock-voice-engine/web/test/fixtures/candidate-ui')), false);
  assert.equal(existsSync(resolve(ROOT, 'flock-voice-engine/web/src/runtime-client.js')), false);
});
