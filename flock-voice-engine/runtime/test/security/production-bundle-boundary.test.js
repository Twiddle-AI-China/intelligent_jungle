import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildFixedProductionGraph } from '../../tools/production-graph-config.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
test('fixed production roots close over server runtime, pure view, and PCM only', () => {
  const graph = buildFixedProductionGraph(ROOT);
  assert.match(graph.sha256, /^[0-9a-f]{64}$/);
  assert.equal(graph.staticRoutes.length, 68);
  const routeByUrl = new Map(graph.staticRoutes.map((route) => [route.url, route]));
  assert.equal(routeByUrl.size, graph.staticRoutes.length);
  assert.equal(routeByUrl.get('/')?.repoPath, 'mvp/index.html');
  assert.equal(routeByUrl.get('/index.html')?.repoPath, 'mvp/index.html');
  assert.equal(routeByUrl.get('/src/server-main.js')?.repoPath, 'mvp/src/server-main.js');
  const mvpHtml = readFileSync(resolve(ROOT, 'mvp/index.html'), 'utf8');
  assert.deepEqual([...mvpHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1]), ['./src/server-main.js']);
  const exactLegacyRoutes = [
    ['/demo.html', 'flock-voice-engine/client/demo.html'],
    ['/tracks.html', 'flock-voice-engine/client/tracks.html'],
    ['/voice-client.js', 'flock-voice-engine/client/voice-client.js'],
    ['/voice-client-production.js', 'flock-voice-engine/client/voice-client-production.js'],
    ['/pcm-player-worklet.js', 'flock-voice-engine/client/pcm-player-worklet.js'],
    ['/assets/timbre/latent_map.json',
      'flock-voice-engine/assets/timbre/latent_map.json'],
    ['/assets/timbre/voice_maps/bass.json',
      'flock-voice-engine/assets/timbre/voice_maps/bass.json'],
    ['/assets/timbre/voice_maps/lead.json',
      'flock-voice-engine/assets/timbre/voice_maps/lead.json'],
    ['/assets/timbre/voice_maps/pad.json',
      'flock-voice-engine/assets/timbre/voice_maps/pad.json'],
    ['/assets/timbre/voice_maps/pluck.json',
      'flock-voice-engine/assets/timbre/voice_maps/pluck.json'],
  ];
  assert.deepEqual(exactLegacyRoutes.map(([url, repoPath]) => [
    url,
    routeByUrl.get(url)?.repoPath,
  ]), exactLegacyRoutes);
  assert.deepEqual(graph.staticRoutes.map(({ url }) => url),
    graph.staticRoutes.map(({ url }) => url).toSorted());
  const mvpFiles = graph.files.filter((repoPath) => repoPath.startsWith('mvp/'));
  assert.equal(mvpFiles.length, 57);
  for (const repoPath of mvpFiles) {
    const urls = graph.staticRoutes.filter((route) => route.repoPath === repoPath)
      .map((route) => route.url);
    assert.deepEqual(urls, repoPath === 'mvp/index.html'
      ? ['/', '/index.html']
      : [`/${repoPath.slice('mvp/'.length)}`], repoPath);
  }
  assert.equal(graph.staticRoutes.some(({ repoPath }) => repoPath === 'mvp/src/main.js'), false);
  for (const route of graph.staticRoutes) {
    assert.equal(route.sha256, graph.fileSha256[route.repoPath]);
  }
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
  assert.equal(graph.files.some((path) => path.startsWith('flock-voice-engine/runtime/tools/')),
    false);
  assert.equal(graph.edges.some(({ resolved }) => resolved.startsWith('external:legacy-client-')), false);
  const voiceClientPath = 'flock-voice-engine/client/voice-client.js';
  const voiceClientBytes = readFileSync(resolve(ROOT, voiceClientPath));
  assert.equal(graph.fileSha256[voiceClientPath],
    createHash('sha256').update(voiceClientBytes).digest('hex'));
  assert.equal(createHash('sha256')
    .update(voiceClientBytes.toString('utf8').replaceAll('\r\n', '\n')).digest('hex'),
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
