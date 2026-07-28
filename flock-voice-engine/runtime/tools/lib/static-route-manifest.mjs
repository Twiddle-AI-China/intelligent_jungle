import { mimeForStaticPath } from '../../src/security/static-manifest-contract.js';

const HEX64 = /^[0-9a-f]{64}$/;
const REPO_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)[^\u0000-\u001f\u007f]+$/;

function fail(detail) {
  const error = new Error(`PRODUCTION_STATIC_ROUTE_INVALID: ${detail}`);
  error.code = 'PRODUCTION_STATIC_ROUTE_INVALID';
  throw error;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validateRepoPath(value) {
  if (typeof value !== 'string' || !REPO_PATH.test(value)
      || value.startsWith('./') || value.endsWith('/') || value.includes('//')) {
    fail(`repo path: ${String(value)}`);
  }
}

function asciiFold(value) {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function validateUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length === 0
      || value.includes('//') || value.includes('\\') || value.includes('%')
      || value.includes('?') || value.includes('#') || /[\u0000-\u001f\u007f]/.test(value)
      || /(?:^|\/)\.{1,2}(?:\/|$)/.test(value)
      || (value.length > 1 && value.endsWith('/'))) {
    fail(`url: ${String(value)}`);
  }
}

export function buildStaticRouteManifest({
  files,
  fileSha256,
  exactRoutes = [],
  publicPrefixes = [],
}) {
  if (!Array.isArray(files) || !fileSha256 || typeof fileSha256 !== 'object'
      || Array.isArray(fileSha256) || !Array.isArray(exactRoutes)
      || !Array.isArray(publicPrefixes)) {
    fail('dependencies');
  }
  const fileSet = new Set(files);
  const routes = [];
  const add = (url, repoPath) => {
    validateUrl(url);
    validateRepoPath(repoPath);
    const fileDigest = fileSha256[repoPath];
    if (!fileSet.has(repoPath) || !HEX64.test(fileDigest ?? '')) {
      fail(`non-graph file: ${repoPath}`);
    }
    routes.push(Object.freeze({
      url,
      repoPath,
      mime: mimeForStaticPath(repoPath),
      sha256: fileDigest,
    }));
  };
  for (const route of exactRoutes) {
    if (!exactKeys(route, ['url', 'repoPath'])) fail('exact route schema');
    add(route.url, route.repoPath);
  }
  for (const prefix of publicPrefixes) {
    if (!exactKeys(prefix, ['repoPrefix', 'urlPrefix'])
        || typeof prefix.repoPrefix !== 'string' || !prefix.repoPrefix.endsWith('/')
        || prefix.repoPrefix.startsWith('/') || prefix.repoPrefix.includes('\\')
        || typeof prefix.urlPrefix !== 'string' || !prefix.urlPrefix.startsWith('/')
        || !prefix.urlPrefix.endsWith('/') || prefix.urlPrefix.startsWith('//')) {
      fail('public prefix schema');
    }
    for (const repoPath of files) {
      if (!repoPath.startsWith(prefix.repoPrefix)) continue;
      const suffix = repoPath.slice(prefix.repoPrefix.length);
      if (suffix.length === 0) continue;
      add(`${prefix.urlPrefix}${suffix}`, repoPath);
    }
  }
  routes.sort((left, right) => (left.url < right.url ? -1 : left.url > right.url ? 1
    : left.repoPath < right.repoPath ? -1 : left.repoPath > right.repoPath ? 1 : 0));
  const exactUrls = new Set();
  const foldedUrls = new Set();
  for (const route of routes) {
    const folded = asciiFold(route.url);
    if (exactUrls.has(route.url) || foldedUrls.has(folded)) fail(`duplicate url: ${route.url}`);
    exactUrls.add(route.url);
    foldedUrls.add(folded);
  }
  return Object.freeze(routes);
}
