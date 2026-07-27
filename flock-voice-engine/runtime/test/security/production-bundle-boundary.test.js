import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildFixedProductionGraph } from '../../tools/production-graph-config.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
test('fixed production roots close over server runtime, pure view, and PCM only', () => {
  const graph = buildFixedProductionGraph(ROOT);
  assert.match(graph.sha256, /^[0-9a-f]{64}$/);
  for (const required of [
    'mvp/src/server-main.js', 'mvp/src/view-app.js', 'mvp/src/runtime-client.js',
    'mvp/src/pcm-player.js', 'mvp/src/pcm-player-worklet.js',
    'flock-voice-engine/runtime/src/index.js',
    'flock-voice-engine/server/audio_worker/__main__.py',
  ]) assert.equal(graph.files.includes(required), true, required);
  for (const forbidden of [
    'mvp/src/main.js', 'mvp/src/world.js', 'mvp/src/agent.js', 'mvp/src/audio.js',
    'mvp/src/ecological-latent.js', 'mvp/src/config.js', 'mvp/src/sequence.js',
    'mvp/src/mix-agent.js',
  ]) assert.equal(graph.files.includes(forbidden), false, forbidden);
  assert.equal(graph.files.some((path) => path.startsWith('mvp/src/llm/')), false);
  assert.equal(graph.files.some((path) => path.startsWith('mvp/src/master/')), false);
  assert.equal(graph.edges.some(({ resolved }) => resolved.startsWith('external:legacy-client-')), false);
  assert.equal(graph.fileSha256['flock-voice-engine/client/voice-client.js'],
    'a008cebb8572e8426f1de6a3ea7cd22630cdd87eec6b03e663c8c7d6971c9df5');
  assert.deepEqual(graph.edges.filter(({ source }) => source
    === 'flock-voice-engine/client/voice-client.js').map((edge) => ({
    line: edge.line, kind: edge.kind, resolved: edge.resolved,
  })), [
    { line: 375, kind: 'js.audio-worklet', resolved: 'external:configurable-audio-worklet' },
    { line: 380, kind: 'js.fetch', resolved: 'external:configurable-fetch' },
    { line: 382, kind: 'js.audio-worklet', resolved: 'external:configurable-audio-worklet' },
    { line: 788, kind: 'js.fetch', resolved: 'external:configurable-fetch' },
    { line: 846, kind: 'js.fetch', resolved: 'external:configurable-fetch' },
  ]);
  assert.deepEqual([...new Set(graph.edges.filter(({ kind }) => kind === 'js.runtime-api')
    .map(({ resolved }) => resolved))].sort(), [
    'runtime-api:/api/decoder-status',
    'runtime-api:/api/v1/bootstrap',
    'runtime-api:/api/v1/latent-maps/bass',
    'runtime-api:/api/v1/latent-maps/melody',
    'runtime-api:/api/v1/latent-maps/pad',
  ]);
});
