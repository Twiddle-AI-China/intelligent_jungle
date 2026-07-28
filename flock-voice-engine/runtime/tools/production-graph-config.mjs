import { buildProductionGraph } from './lib/production-graph.mjs';
import { PRODUCTION_EXACT_STATIC_ROUTES } from '../src/security/static-manifest-contract.js';

export const PRODUCTION_GRAPH_ROOTS = Object.freeze([
  Object.freeze({ kind: 'html', path: 'mvp/index.html' }),
  Object.freeze({ kind: 'node', path: 'flock-voice-engine/runtime/src/index.js' }),
  Object.freeze({ kind: 'python', path: 'flock-voice-engine/server/audio_worker/__main__.py' }),
  Object.freeze({ kind: 'html', path: 'flock-voice-engine/client/demo.html' }),
  Object.freeze({ kind: 'html', path: 'flock-voice-engine/client/tracks.html' }),
  Object.freeze({ kind: 'js', path: 'flock-voice-engine/client/voice-client.js' }),
  Object.freeze({ kind: 'js', path: 'flock-voice-engine/client/voice-client-production.js' }),
  Object.freeze({ kind: 'js', path: 'flock-voice-engine/client/pcm-player-worklet.js' }),
  Object.freeze({ kind: 'asset', path: 'flock-voice-engine/assets/timbre/latent_map.json' }),
  Object.freeze({ kind: 'asset', path: 'flock-voice-engine/assets/timbre/voice_maps/bass.json' }),
  Object.freeze({ kind: 'asset', path: 'flock-voice-engine/assets/timbre/voice_maps/lead.json' }),
  Object.freeze({ kind: 'asset', path: 'flock-voice-engine/assets/timbre/voice_maps/pad.json' }),
  Object.freeze({ kind: 'asset', path: 'flock-voice-engine/assets/timbre/voice_maps/pluck.json' }),
]);

export const PRODUCTION_REALM_OVERRIDES = Object.freeze({
  'flock-voice-engine/client/voice-client.js': 'browser-library',
  'flock-voice-engine/client/voice-client-production.js': 'browser',
  'flock-voice-engine/client/pcm-player-worklet.js': 'browser',
});

export const PRODUCTION_STATIC_ROUTE_CONFIG = Object.freeze({
  publicPrefixes: Object.freeze([
    Object.freeze({ repoPrefix: 'mvp/src/', urlPrefix: '/src/' }),
    Object.freeze({ repoPrefix: 'mvp/assets/', urlPrefix: '/assets/' }),
  ]),
  exactRoutes: PRODUCTION_EXACT_STATIC_ROUTES,
});

export function buildFixedProductionGraph(repoRoot) {
  return buildProductionGraph({ repoRoot, roots: PRODUCTION_GRAPH_ROOTS,
    realmOverrides: PRODUCTION_REALM_OVERRIDES,
    staticRouteConfig: PRODUCTION_STATIC_ROUTE_CONFIG });
}
