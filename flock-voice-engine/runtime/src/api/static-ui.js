import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  realpath,
} from 'node:fs/promises';
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import {
  canonicalJson,
  expectedProductionStaticRoutePairs,
  mimeForStaticPath,
  productionEdgeSortKey,
  validProductionGraphEdge,
} from '../security/static-manifest-contract.js';
import { writeOriginPolicyHttpFailure } from './origin-policy.js';

const HEX64 = /^[0-9a-f]{64}$/;
const GRAPH_KEYS = ['edges', 'fileSha256', 'files', 'sha256', 'staticRoutes'];
const EDGE_KEYS = ['kind', 'line', 'resolved', 'source', 'specifier'];
const ROUTE_KEYS = ['mime', 'repoPath', 'sha256', 'url'];

function fail(code, detail, cause) {
  const error = new Error(detail ? `${code}: ${detail}` : code,
    cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function isSortedUnique(values) {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

function canonicalRepoPath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/')
    && !value.startsWith('./') && !value.endsWith('/') && !value.includes('\\')
    && !value.includes('//') && !/[\u0000-\u001f\u007f]/.test(value)
    && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value);
}

function canonicalRouteUrl(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('//')
    && !value.includes('\\') && !value.includes('%') && !value.includes('?')
    && !value.includes('#') && !/[\u0000-\u001f\u007f]/.test(value)
    && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value)
    && (value === '/' || !value.endsWith('/'));
}

function asciiFold(value) {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function validateGraph(graph) {
  const fileHashPaths = graph?.fileSha256 && typeof graph.fileSha256 === 'object'
    && !Array.isArray(graph.fileSha256) ? Object.keys(graph.fileSha256).sort() : [];
  if (!exactKeys(graph, GRAPH_KEYS) || !HEX64.test(graph.sha256)
      || !Array.isArray(graph.files) || !isSortedUnique(graph.files)
      || graph.files.some((path) => !canonicalRepoPath(path))
      || !graph.fileSha256 || typeof graph.fileSha256 !== 'object'
      || Array.isArray(graph.fileSha256)
      || fileHashPaths.length !== graph.files.length
      || fileHashPaths.some((path, index) => path !== graph.files[index])
      || graph.files.some((path) => !HEX64.test(graph.fileSha256[path]))
      || !Array.isArray(graph.edges) || !Array.isArray(graph.staticRoutes)) {
    fail('PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID');
  }
  const fileSet = new Set(graph.files);
  const edgeOrder = [];
  for (const edge of graph.edges) {
    if (!exactKeys(edge, EDGE_KEYS) || !fileSet.has(edge.source)
        || !Number.isSafeInteger(edge.line) || edge.line < 1
        || typeof edge.kind !== 'string' || edge.kind.length === 0
        || typeof edge.specifier !== 'string' || edge.specifier.length === 0
        || typeof edge.resolved !== 'string' || edge.resolved.length === 0
        || !validProductionGraphEdge(edge, fileSet, canonicalRepoPath)
        || (edge.specifier.includes('?v=')
          && !edge.specifier.endsWith(`?v=${graph.fileSha256[edge.resolved]?.slice(0, 12)}`))) {
      fail('PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID', 'edge');
    }
    edgeOrder.push(productionEdgeSortKey(edge));
  }
  if (edgeOrder.some((key, index) => index > 0
      && edgeOrder[index - 1] >= key)) {
    fail('PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID', 'edge order');
  }
  const routeOrder = [];
  const folded = new Set();
  for (const route of graph.staticRoutes) {
    if (!exactKeys(route, ROUTE_KEYS) || !canonicalRouteUrl(route.url)
        || !canonicalRepoPath(route.repoPath) || !fileSet.has(route.repoPath)
        || !HEX64.test(route.sha256) || graph.fileSha256[route.repoPath] !== route.sha256) {
      fail('PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID', 'route');
    }
    let expectedMime;
    try {
      expectedMime = mimeForStaticPath(route.repoPath);
    } catch (error) {
      fail('PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID', 'route MIME', error);
    }
    if (route.mime !== expectedMime || folded.has(asciiFold(route.url))) {
      fail('PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID', 'route MIME or duplicate');
    }
    folded.add(asciiFold(route.url));
    routeOrder.push(`${route.url}\0${route.repoPath}`);
  }
  if (!isSortedUnique(routeOrder)) {
    fail('PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID', 'route order');
  }
  const expectedRoutes = expectedProductionStaticRoutePairs(graph.files);
  if (expectedRoutes === null || expectedRoutes.size !== graph.staticRoutes.length
      || graph.staticRoutes.some((route) => expectedRoutes.get(route.url) !== route.repoPath)) {
    fail('PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID', 'route topology');
  }
  const digestBody = {
    files: graph.files,
    edges: graph.edges,
    fileSha256: graph.fileSha256,
    staticRoutes: graph.staticRoutes,
  };
  if (sha256(Buffer.from(canonicalJson(digestBody))) !== graph.sha256) {
    fail('PRODUCTION_STATIC_GRAPH_DIGEST_MISMATCH');
  }
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function readStableRegular(path) {
  let handle;
  try {
    const beforePath = await lstat(path);
    if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
      fail('PRODUCTION_STATIC_PATH_INVALID', path);
    }
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) fail('PRODUCTION_STATIC_PATH_INVALID', path);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameStat(before, after)) fail('PRODUCTION_STATIC_FILE_CHANGED', path);
    const afterPath = await lstat(path);
    if (afterPath.isSymbolicLink() || !sameStat(beforePath, afterPath)) {
      fail('PRODUCTION_STATIC_FILE_CHANGED', path);
    }
    return bytes;
  } catch (error) {
    if (error?.code?.startsWith?.('PRODUCTION_STATIC_')) throw error;
    fail('PRODUCTION_STATIC_PATH_INVALID', path, error);
  } finally {
    await handle?.close?.();
  }
}

async function exactStaticPath(repoRoot, repoPath) {
  const absolute = resolve(repoRoot, ...repoPath.split('/'));
  const rel = relative(repoRoot, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail('PRODUCTION_STATIC_PATH_INVALID', repoPath);
  }
  let cursor = repoRoot;
  const parts = repoPath.split('/');
  for (const [index, part] of parts.entries()) {
    let names;
    try {
      names = await readdir(cursor);
    } catch (error) {
      fail('PRODUCTION_STATIC_PATH_INVALID', repoPath, error);
    }
    const exact = names.filter((name) => name === part);
    const folded = names.filter((name) => name.toLowerCase() === part.toLowerCase());
    if (exact.length !== 1 || folded.length !== 1) {
      fail('PRODUCTION_STATIC_PATH_CASE_MISMATCH', repoPath);
    }
    cursor = resolve(cursor, part);
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      fail('PRODUCTION_STATIC_PATH_INVALID', repoPath, error);
    }
    if (stat.isSymbolicLink()
        || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      fail('PRODUCTION_STATIC_PATH_INVALID', repoPath);
    }
  }
  return absolute;
}

function parseRawTarget(rawTarget) {
  if (typeof rawTarget !== 'string' || rawTarget.length === 0
      || /[\u0000-\u001f\u007f#\\]/.test(rawTarget)) {
    return { invalid: true };
  }
  const queryAt = rawTarget.indexOf('?');
  const pathname = queryAt === -1 ? rawTarget : rawTarget.slice(0, queryAt);
  if (!pathname.startsWith('/') || pathname.includes('//') || pathname.includes('%')
      || /(?:^|\/)\.{1,2}(?:\/|$)/.test(pathname)) {
    return { invalid: true };
  }
  return { invalid: false, pathname };
}

function sendNotFound(response) {
  response.writeHead(404, {
    'content-length': 0,
    'x-content-type-options': 'nosniff',
  });
  response.end();
}

export async function loadStaticUi({
  repoRoot,
  graphPath,
  releaseManifest,
  originPolicy,
}) {
  if (!isAbsolute(repoRoot) || !isAbsolute(graphPath)
      || !HEX64.test(releaseManifest?.productionGraphSha256 ?? '')
      || typeof originPolicy?.authorize !== 'function'
      || !Object.isFrozen(originPolicy)) {
    fail('PRODUCTION_STATIC_GRAPH_IDENTITY_REQUIRED');
  }
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(repoRoot);
  } catch (error) {
    fail('PRODUCTION_STATIC_PATH_INVALID', repoRoot, error);
  }
  if (canonicalRoot !== resolve(repoRoot)) {
    fail('PRODUCTION_STATIC_PATH_INVALID', repoRoot);
  }
  const graphBytes = await readStableRegular(graphPath);
  if (sha256(graphBytes) !== releaseManifest.productionGraphSha256) {
    fail('PRODUCTION_STATIC_GRAPH_OUTER_DIGEST_MISMATCH');
  }
  let graph;
  try {
    graph = JSON.parse(graphBytes.toString('utf8'));
  } catch (error) {
    fail('PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID', 'JSON', error);
  }
  if (!Buffer.from(canonicalJson(graph)).equals(graphBytes)) {
    fail('PRODUCTION_STATIC_GRAPH_NOT_CANONICAL');
  }
  validateGraph(graph);

  const byRepoPath = new Map();
  for (const route of graph.staticRoutes) {
    if (byRepoPath.has(route.repoPath)) continue;
    const path = await exactStaticPath(canonicalRoot, route.repoPath);
    const bytes = await readStableRegular(path);
    if (sha256(bytes) !== route.sha256) {
      fail('PRODUCTION_STATIC_FILE_DIGEST_MISMATCH', route.repoPath);
    }
    byRepoPath.set(route.repoPath, bytes);
  }
  const routes = new Map(graph.staticRoutes.map((route) => [
    route.url,
    Object.freeze({ ...route, bytes: byRepoPath.get(route.repoPath) }),
  ]));

  return Object.freeze({
    graphSha256: graph.sha256,
    originPolicy,
    handleHttp(request, response) {
      const parsed = parseRawTarget(request.url);
      if (parsed.invalid) {
        sendNotFound(response);
        return true;
      }
      const route = routes.get(parsed.pathname);
      if (!route) return false;
      const surface = request.method === 'GET' && route.mime === 'text/html; charset=utf-8'
        ? 'document' : 'static';
      const decision = originPolicy.authorize(surface, request);
      if (!decision.allowed) {
        writeOriginPolicyHttpFailure(response, decision, { head: request.method === 'HEAD' });
        return true;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        sendNotFound(response);
        return true;
      }
      response.writeHead(200, {
        'content-type': route.mime,
        'content-length': route.bytes.length,
        'x-content-type-options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? Buffer.alloc(0) : route.bytes);
      return true;
    },
  });
}
