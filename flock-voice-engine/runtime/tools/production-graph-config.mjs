import { buildProductionGraph } from './lib/production-graph.mjs';

export const PRODUCTION_GRAPH_ROOTS = Object.freeze([
  Object.freeze({ kind: 'html', path: 'mvp/index.html' }),
  Object.freeze({ kind: 'node', path: 'flock-voice-engine/runtime/src/index.js' }),
  Object.freeze({ kind: 'python', path: 'flock-voice-engine/server/audio_worker/__main__.py' }),
]);

export const PRODUCTION_REALM_OVERRIDES = Object.freeze({
  'flock-voice-engine/client/voice-client.js': 'browser-library',
  'flock-voice-engine/client/voice-client-production.js': 'browser',
  'flock-voice-engine/client/pcm-player-worklet.js': 'browser',
});

export function buildFixedProductionGraph(repoRoot) {
  return buildProductionGraph({ repoRoot, roots: PRODUCTION_GRAPH_ROOTS,
    realmOverrides: PRODUCTION_REALM_OVERRIDES });
}
