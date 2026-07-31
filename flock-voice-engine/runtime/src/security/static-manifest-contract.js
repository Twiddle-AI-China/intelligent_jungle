import { posix as path } from 'node:path';

const MIME_BY_EXTENSION = Object.freeze({
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

export const PRODUCTION_EXACT_STATIC_ROUTES = Object.freeze([
  Object.freeze({ url: '/', repoPath: 'mvp/index.html' }),
  Object.freeze({ url: '/index.html', repoPath: 'mvp/index.html' }),
  Object.freeze({
    url: '/demo.html',
    repoPath: 'flock-voice-engine/client/demo.html',
  }),
  Object.freeze({
    url: '/tracks.html',
    repoPath: 'flock-voice-engine/client/tracks.html',
  }),
  Object.freeze({
    url: '/voice-client.js',
    repoPath: 'flock-voice-engine/client/voice-client.js',
  }),
  Object.freeze({
    url: '/voice-client-production.js',
    repoPath: 'flock-voice-engine/client/voice-client-production.js',
  }),
  Object.freeze({
    url: '/pcm-player-worklet.js',
    repoPath: 'flock-voice-engine/client/pcm-player-worklet.js',
  }),
  Object.freeze({
    url: '/assets/timbre/latent_map.json',
    repoPath: 'flock-voice-engine/assets/timbre/latent_map.json',
  }),
  Object.freeze({
    url: '/assets/timbre/voice_maps/bass.json',
    repoPath: 'flock-voice-engine/assets/timbre/voice_maps/bass.json',
  }),
  Object.freeze({
    url: '/assets/timbre/voice_maps/lead.json',
    repoPath: 'flock-voice-engine/assets/timbre/voice_maps/lead.json',
  }),
  Object.freeze({
    url: '/assets/timbre/voice_maps/pad.json',
    repoPath: 'flock-voice-engine/assets/timbre/voice_maps/pad.json',
  }),
  Object.freeze({
    url: '/assets/timbre/voice_maps/pluck.json',
    repoPath: 'flock-voice-engine/assets/timbre/voice_maps/pluck.json',
  }),
]);

const PRODUCTION_EXTERNAL_EDGES = Object.freeze({
  'external:configurable-audio-worklet': Object.freeze({
    kind: 'js.audio-worklet',
    specifier: 'external:configurable-audio-worklet',
    sources: Object.freeze(['flock-voice-engine/client/voice-client.js']),
  }),
  'external:configurable-fetch': Object.freeze({
    kind: 'js.fetch',
    specifier: 'external:configurable-fetch',
    sources: Object.freeze(['flock-voice-engine/client/voice-client.js']),
  }),
  'external:ws': Object.freeze({
    kind: 'js.external',
    specifier: 'ws',
    sources: Object.freeze([
      'flock-voice-engine/runtime/src/api/audio-ws.js',
      'flock-voice-engine/runtime/src/api/legacy-routes.js',
      'flock-voice-engine/runtime/src/api/runtime-ws.js',
      'flock-voice-engine/runtime/src/runtime-app.js',
    ]),
  }),
});

const PRODUCTION_RUNTIME_API_TARGETS = Object.freeze({
  '/api/decoder-status': Object.freeze([
    'flock-voice-engine/client/voice-client-production.js',
  ]),
  '/api/v1/bootstrap': Object.freeze(['mvp/src/server-main.js']),
  '/api/v1/latent-maps/bass': Object.freeze(['mvp/src/server-main.js']),
  '/api/v1/latent-maps/melody': Object.freeze(['mvp/src/server-main.js']),
  '/api/v1/latent-maps/pad': Object.freeze(['mvp/src/server-main.js']),
});

const INTERNAL_EDGE_KINDS = new Set([
  'html.link',
  'html.src',
  'js.audio-worklet',
  'js.fetch',
  'js.import',
  'js.reexport',
  'js.static-asset',
  'js.url',
  'python.from',
  'python.from-name',
]);

const ASSET_ROOT_EDGE = Object.freeze({
  source: 'flock-voice-engine/runtime/src/simulation-runtime.js',
  kind: 'js.url',
  specifier: '../../assets/timbre/voice_maps/',
  resolved: 'flock-voice-engine/assets/timbre/voice_maps',
});

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

export function mimeForStaticPath(repoPath) {
  const filename = String(repoPath);
  const dot = filename.lastIndexOf('.');
  const extension = dot === -1 ? '' : filename.slice(dot).toLowerCase();
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) {
    const error = new Error(`PRODUCTION_STATIC_ROUTE_INVALID: unsupported MIME: ${filename}`);
    error.code = 'PRODUCTION_STATIC_ROUTE_INVALID';
    throw error;
  }
  return mime;
}

export function expectedProductionStaticRoutePairs(files) {
  if (!Array.isArray(files) || files.some((path) => typeof path !== 'string')) return null;
  const fileSet = new Set(files);
  const pairs = new Map();
  for (const route of PRODUCTION_EXACT_STATIC_ROUTES) {
    if (!fileSet.has(route.repoPath) || pairs.has(route.url)) return null;
    pairs.set(route.url, route.repoPath);
  }
  for (const path of files) {
    if (!path.startsWith('mvp/')) continue;
    if (path === 'mvp/index.html') continue;
    let url;
    if (path.startsWith('mvp/src/')) url = `/${path.slice('mvp/'.length)}`;
    else if (path.startsWith('mvp/assets/')) url = `/${path.slice('mvp/'.length)}`;
    else return null;
    if (pairs.has(url)) return null;
    pairs.set(url, path);
  }
  return pairs;
}

function sourceMatchesKind(source, kind) {
  if (kind === 'html.src' || kind === 'html.link') return /\.html?$/i.test(source);
  if (kind.startsWith('python.')) return source.endsWith('.py');
  if (kind === 'js.fetch') return /\.(?:html?|m?js)$/i.test(source);
  return /\.(?:m?js)$/i.test(source);
}

function targetMatchesKind(resolved, kind) {
  if (kind === 'html.src' || kind === 'js.audio-worklet') {
    return /\.(?:m?js)$/i.test(resolved);
  }
  if (kind === 'html.link') return /\.(?:css|m?js)$/i.test(resolved);
  if (kind === 'js.import' || kind === 'js.reexport') {
    return /\.(?:m?js|json)$/i.test(resolved);
  }
  if (kind.startsWith('python.')) return resolved.endsWith('.py');
  return true;
}

function resolvedInternalSpecifier(edge) {
  const { source, specifier } = edge;
  let candidate;
  if (specifier.startsWith('/assets/')) candidate = `flock-voice-engine${specifier}`;
  else if (specifier.startsWith('/')) candidate = specifier.slice(1);
  else if (specifier.startsWith('assets/') && source.startsWith('mvp/src/')) {
    candidate = `mvp/${specifier}`;
  } else {
    candidate = path.join(path.dirname(source), specifier);
  }
  return path.normalize(candidate).replace(/\/$/, '');
}

export function validProductionGraphEdge(edge, fileSet, canonicalRepoPath) {
  if (!(fileSet instanceof Set) || typeof canonicalRepoPath !== 'function'
      || !fileSet.has(edge.source) || !sourceMatchesKind(edge.source, edge.kind)
      || typeof edge.specifier !== 'string' || edge.specifier.length === 0
      || /[\u0000-\u001f\u007f]/.test(edge.specifier)
      || typeof edge.resolved !== 'string' || edge.resolved.length === 0) {
    return false;
  }
  if (edge.resolved.startsWith('external:')) {
    const expected = PRODUCTION_EXTERNAL_EDGES[edge.resolved];
    return expected?.kind === edge.kind && expected.specifier === edge.specifier
      && expected.sources.includes(edge.source);
  }
  if (edge.resolved.startsWith('runtime-api:')) {
    const target = edge.resolved.slice('runtime-api:'.length);
    return edge.kind === 'js.runtime-api' && edge.specifier === target
      && PRODUCTION_RUNTIME_API_TARGETS[target]?.includes(edge.source) === true;
  }
  if (!INTERNAL_EDGE_KINDS.has(edge.kind) || !canonicalRepoPath(edge.resolved)) {
    return false;
  }
  if (!edge.kind.startsWith('python.')
      && resolvedInternalSpecifier(edge) !== edge.resolved) {
    return false;
  }
  if (fileSet.has(edge.resolved)) return targetMatchesKind(edge.resolved, edge.kind);
  if (edge.source !== ASSET_ROOT_EDGE.source
      || edge.kind !== ASSET_ROOT_EDGE.kind
      || edge.specifier !== ASSET_ROOT_EDGE.specifier
      || edge.resolved !== ASSET_ROOT_EDGE.resolved) {
    return false;
  }
  const prefix = `${edge.resolved}/`;
  const descendants = [...fileSet].filter((path) => path.startsWith(prefix));
  return descendants.length === 4
    && descendants.every((path) => /^flock-voice-engine\/assets\/timbre\/voice_maps\/(?:bass|lead|pad|pluck)\.json$/.test(path));
}

export function productionEdgeSortKey(edge) {
  return JSON.stringify({
    source: edge.source,
    line: edge.line,
    kind: edge.kind,
    specifier: edge.specifier,
    resolved: edge.resolved,
  });
}
