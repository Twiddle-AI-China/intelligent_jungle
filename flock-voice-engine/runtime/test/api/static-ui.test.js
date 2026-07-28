import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createOriginPolicy } from '../../src/api/origin-policy.js';
import { loadStaticUi } from '../../src/api/static-ui.js';
import { productionEdgeSortKey } from '../../src/security/static-manifest-contract.js';
import {
  buildProductionGraph,
  canonicalJson,
} from '../../tools/lib/production-graph.mjs';
import {
  buildFixedProductionGraph,
  PRODUCTION_STATIC_ROUTE_CONFIG,
} from '../../tools/production-graph-config.mjs';
import { createCandidateServer } from '../../src/server.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CANONICAL_ORIGIN = 'http://127.0.0.1:18090';
const CANONICAL_AUTHORITY = '127.0.0.1:18090';
const ORIGIN_POLICY = createOriginPolicy({ canonicalOrigin: CANONICAL_ORIGIN });

function staticRequest(method, url, {
  host = CANONICAL_AUTHORITY,
  origin,
  mode,
  destination,
  site,
  extra = [],
} = {}) {
  const rawHeaders = ['Host', host];
  if (origin !== undefined) rawHeaders.push('Origin', origin);
  if (mode !== undefined) rawHeaders.push('Sec-Fetch-Mode', mode);
  if (destination !== undefined) rawHeaders.push('Sec-Fetch-Dest', destination);
  if (site !== undefined) rawHeaders.push('Sec-Fetch-Site', site);
  rawHeaders.push(...extra);
  return {
    method,
    url,
    rawHeaders,
    headers: { host: CANONICAL_AUTHORITY, origin: CANONICAL_ORIGIN },
  };
}

const documentRequest = (url) => staticRequest('GET', url, {
  mode: 'navigate',
  destination: 'document',
  site: 'same-origin',
});

async function materialize(files) {
  const root = await mkdtemp(join(tmpdir(), 'flock-static-ui-'));
  for (const [path, source] of Object.entries(files)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  return root;
}

async function graphFixture() {
  const root = await materialize({
    'mvp/index.html': '<script type="module" src="./src/server-main.js"></script>',
    'mvp/src/server-main.js': 'export const ready = true;\n',
    'flock-voice-engine/client/demo.html': '<!doctype html><title>legacy</title>\n',
    'flock-voice-engine/client/tracks.html': '<!doctype html><title>tracks</title>\n',
    'flock-voice-engine/client/voice-client.js': 'export const legacy = true;\n',
    'flock-voice-engine/client/voice-client-production.js':
      'export const production = true;\n',
    'flock-voice-engine/client/pcm-player-worklet.js': 'export const worklet = true;\n',
    'flock-voice-engine/assets/timbre/latent_map.json': '{}',
    'flock-voice-engine/assets/timbre/voice_maps/bass.json': '{}',
    'flock-voice-engine/assets/timbre/voice_maps/lead.json': '{}',
    'flock-voice-engine/assets/timbre/voice_maps/pad.json': '{}',
    'flock-voice-engine/assets/timbre/voice_maps/pluck.json': '{}',
  });
  const builtGraph = buildProductionGraph({
    repoRoot: root,
    roots: [
      { kind: 'html', path: 'mvp/index.html' },
      { kind: 'html', path: 'flock-voice-engine/client/demo.html' },
      { kind: 'html', path: 'flock-voice-engine/client/tracks.html' },
      { kind: 'js', path: 'flock-voice-engine/client/voice-client.js' },
      { kind: 'js', path: 'flock-voice-engine/client/voice-client-production.js' },
      { kind: 'js', path: 'flock-voice-engine/client/pcm-player-worklet.js' },
      { kind: 'asset', path: 'flock-voice-engine/assets/timbre/latent_map.json' },
      { kind: 'asset', path: 'flock-voice-engine/assets/timbre/voice_maps/bass.json' },
      { kind: 'asset', path: 'flock-voice-engine/assets/timbre/voice_maps/lead.json' },
      { kind: 'asset', path: 'flock-voice-engine/assets/timbre/voice_maps/pad.json' },
      { kind: 'asset', path: 'flock-voice-engine/assets/timbre/voice_maps/pluck.json' },
    ],
    staticRouteConfig: PRODUCTION_STATIC_ROUTE_CONFIG,
  });
  const graph = JSON.parse(canonicalJson(builtGraph));
  const graphBytes = Buffer.from(canonicalJson(graph));
  const graphPath = join(root, 'production-graph.json');
  await writeFile(graphPath, graphBytes);
  return {
    root,
    graph,
    graphPath,
    graphBytes,
    releaseManifest: { productionGraphSha256: sha(graphBytes) },
  };
}

async function writeGraphFixture(fixture, { recomputeInner = true } = {}) {
  if (recomputeInner) {
    fixture.graph.sha256 = sha(Buffer.from(canonicalJson({
      files: fixture.graph.files,
      edges: fixture.graph.edges,
      fileSha256: fixture.graph.fileSha256,
      staticRoutes: fixture.graph.staticRoutes,
    })));
  }
  const bytes = Buffer.from(canonicalJson(fixture.graph));
  await writeFile(fixture.graphPath, bytes);
  fixture.releaseManifest.productionGraphSha256 = sha(bytes);
}

function responseCapture() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = Buffer.alloc(0)) {
      this.body = Buffer.from(body);
    },
  };
}

function rawHttp(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    socket.on('connect', () => socket.end(`${lines.join('\r\n')}\r\n\r\n`));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

test('trusted static loader verifies both graph digests and preloads exact route bytes', async (context) => {
  const fixture = await graphFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const staticUi = await loadStaticUi({
    repoRoot: fixture.root,
    graphPath: fixture.graphPath,
    releaseManifest: fixture.releaseManifest,
    originPolicy: ORIGIN_POLICY,
  });
  assert.equal(Object.isFrozen(staticUi), true);
  assert.equal(staticUi.originPolicy, ORIGIN_POLICY);
  await writeFile(join(fixture.root, 'mvp/index.html'), 'tampered after preload');
  for (const url of ['/', '/index.html', '/demo.html', '/src/server-main.js']) {
    const response = responseCapture();
    const request = url.endsWith('.js') ? staticRequest('GET', url) : documentRequest(url);
    assert.equal(staticUi.handleHttp(request, response), true);
    assert.equal(response.statusCode, 200);
    assert.equal(Number(response.headers['content-length']), response.body.length);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['content-type'],
      url.endsWith('.js') ? 'application/javascript; charset=utf-8'
        : 'text/html; charset=utf-8');
  }
  const rootResponse = responseCapture();
  staticUi.handleHttp(documentRequest('/'), rootResponse);
  assert.equal(rootResponse.body.toString('utf8'),
    '<script type="module" src="./src/server-main.js"></script>');
});

test('trusted static loader isolates outer, inner, schema, MIME, route and file tampering', async () => {
  const cases = [
    {
      expected: /PRODUCTION_STATIC_GRAPH_OUTER_DIGEST_MISMATCH/,
      mutate: async (fixture) => {
        fixture.releaseManifest.productionGraphSha256 = '0'.repeat(64);
      },
    },
    {
      expected: /PRODUCTION_STATIC_GRAPH_DIGEST_MISMATCH/,
      mutate: async (fixture) => {
        fixture.graph.edges[0].line += 1;
        await writeGraphFixture(fixture, { recomputeInner: false });
      },
    },
    {
      expected: /PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID/,
      mutate: async (fixture) => {
        fixture.graph.staticRoutes[0].mime = 'text/plain; charset=utf-8';
        await writeGraphFixture(fixture);
      },
    },
    {
      expected: /PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID/,
      mutate: async (fixture) => {
        fixture.graph.staticRoutes[0].repoPath = 'not-in-graph.html';
        await writeGraphFixture(fixture);
      },
    },
    {
      expected: /PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID/,
      mutate: async (fixture) => {
        fixture.graph.staticRoutes[0].sha256 = '0'.repeat(64);
        await writeGraphFixture(fixture);
      },
    },
    {
      expected: /PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID/,
      mutate: async (fixture) => {
        fixture.graph.unexpected = true;
        await writeGraphFixture(fixture);
      },
    },
    {
      expected: /PRODUCTION_STATIC_FILE_DIGEST_MISMATCH/,
      mutate: async (fixture) => {
        await writeFile(
          join(fixture.root, 'flock-voice-engine/client/demo.html'),
          'changed bytes',
        );
      },
    },
    {
      expected: /PRODUCTION_STATIC_GRAPH_NOT_CANONICAL/,
      mutate: async (fixture) => {
        await writeFile(fixture.graphPath, `${JSON.stringify(fixture.graph, null, 2)}\n`);
        fixture.releaseManifest.productionGraphSha256 = sha(await readFile(fixture.graphPath));
      },
    },
    {
      expected: /PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID/,
      mutate: async (fixture) => {
        const duplicate = {
          ...fixture.graph.staticRoutes.find(({ url }) => url === '/index.html'),
          url: '/Index.html',
        };
        fixture.graph.staticRoutes.push(duplicate);
        fixture.graph.staticRoutes.sort((left, right) => left.url.localeCompare(right.url)
          || left.repoPath.localeCompare(right.repoPath));
        await writeGraphFixture(fixture);
      },
    },
  ];
  for (const { mutate, expected } of cases) {
    const fixture = await graphFixture();
    try {
      await mutate(fixture);
      await assert.rejects(loadStaticUi({
        repoRoot: fixture.root,
        graphPath: fixture.graphPath,
        releaseManifest: fixture.releaseManifest,
        originPolicy: ORIGIN_POLICY,
      }), expected);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('trusted static loader rejects fully rebound extra and replacement route topologies', async () => {
  for (const replaceExisting of [false, true]) {
    const fixture = await graphFixture();
    try {
      const exposed = fixture.graph.staticRoutes.find(
        ({ url }) => url === '/src/server-main.js',
      );
      if (replaceExisting) {
        fixture.graph.staticRoutes = fixture.graph.staticRoutes.filter(
          ({ url }) => url !== '/src/server-main.js',
        );
      }
      fixture.graph.staticRoutes.push({
        ...exposed,
        url: '/leak-runtime.js',
      });
      fixture.graph.staticRoutes.sort((left, right) => left.url.localeCompare(right.url)
        || left.repoPath.localeCompare(right.repoPath));
      await writeGraphFixture(fixture);
      await assert.rejects(loadStaticUi({
        repoRoot: fixture.root,
        graphPath: fixture.graphPath,
        releaseManifest: fixture.releaseManifest,
        originPolicy: ORIGIN_POLICY,
      }), /PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('trusted static loader rejects fully rebound unknown, external and duplicate edges', async () => {
  const cases = [
    (fixture) => {
      fixture.graph.edges[0].kind = 'js.unknown';
    },
    (fixture) => {
      fixture.graph.edges.push({
        source: 'mvp/src/server-main.js',
        line: 1,
        kind: 'js.external',
        specifier: 'evil',
        resolved: 'external:evil',
      });
    },
    (fixture) => {
      fixture.graph.edges.push({
        source: 'mvp/src/server-main.js',
        line: 1,
        kind: 'js.external',
        specifier: 'ws',
        resolved: 'external:ws',
      });
    },
    (fixture) => {
      fixture.graph.edges.push({
        source: 'mvp/src/server-main.js',
        line: 1,
        kind: 'js.runtime-api',
        specifier: '/api/v1/evil',
        resolved: 'runtime-api:/api/v1/evil',
      });
    },
    (fixture) => {
      fixture.graph.edges.push({
        source: 'flock-voice-engine/client/voice-client-production.js',
        line: 1,
        kind: 'js.runtime-api',
        specifier: '/api/v1/bootstrap',
        resolved: 'runtime-api:/api/v1/bootstrap',
      });
    },
    (fixture) => {
      fixture.graph.edges[0].source = 'mvp/src/server-main.js';
    },
    (fixture) => {
      fixture.graph.edges.push({ ...fixture.graph.edges[0] });
    },
  ];
  for (const mutate of cases) {
    const fixture = await graphFixture();
    try {
      mutate(fixture);
      fixture.graph.edges.sort((left, right) => {
        const leftKey = JSON.stringify(left);
        const rightKey = JSON.stringify(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
      await writeGraphFixture(fixture);
      await assert.rejects(loadStaticUi({
        repoRoot: fixture.root,
        graphPath: fixture.graphPath,
        releaseManifest: fixture.releaseManifest,
        originPolicy: ORIGIN_POLICY,
      }), /PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('trusted static loader rejects fully rebound edge order drift', async () => {
  const fixture = await graphFixture();
  try {
    fixture.graph.edges.push({
      source: 'flock-voice-engine/client/voice-client-production.js',
      line: 1,
      kind: 'js.import',
      specifier: './pcm-player-worklet.js',
      resolved: 'flock-voice-engine/client/pcm-player-worklet.js',
    });
    fixture.graph.edges.sort((left, right) => {
      const leftKey = productionEdgeSortKey(left);
      const rightKey = productionEdgeSortKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    fixture.graph.edges.reverse();
    await writeGraphFixture(fixture);
    await assert.rejects(loadStaticUi({
      repoRoot: fixture.root,
      graphPath: fixture.graphPath,
      releaseManifest: fixture.releaseManifest,
      originPolicy: ORIGIN_POLICY,
    }), /PRODUCTION_STATIC_GRAPH_SCHEMA_INVALID/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('trusted static loader accepts the real fixed graph including its bounded asset-root edge', async (context) => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const output = await mkdtemp(join(tmpdir(), 'flock-fixed-static-ui-'));
  context.after(() => rm(output, { recursive: true, force: true }));
  const graph = buildFixedProductionGraph(repoRoot);
  assert.equal(graph.files.length, 165);
  assert.equal(graph.staticRoutes.length, 68);
  const graphBytes = Buffer.from(canonicalJson(graph));
  const graphPath = join(output, 'production-graph.json');
  await writeFile(graphPath, graphBytes);
  const staticUi = await loadStaticUi({
    repoRoot,
    graphPath,
    releaseManifest: { productionGraphSha256: sha(graphBytes) },
    originPolicy: ORIGIN_POLICY,
  });
  assert.equal(staticUi.graphSha256, graph.sha256);
});

test('trusted static loader rejects case drift, symlinks, directories and missing outer identity', async () => {
  const missing = await graphFixture();
  await assert.rejects(loadStaticUi({
    repoRoot: missing.root,
    graphPath: missing.graphPath,
    releaseManifest: {},
    originPolicy: ORIGIN_POLICY,
  }), /PRODUCTION_STATIC_GRAPH_IDENTITY_REQUIRED/);
  await rm(missing.root, { recursive: true, force: true });

  const caseDrift = await graphFixture();
  await rename(join(caseDrift.root, 'mvp'), join(caseDrift.root, 'mvp-renaming'));
  await rename(join(caseDrift.root, 'mvp-renaming'), join(caseDrift.root, 'MVP'));
  await assert.rejects(loadStaticUi({
    repoRoot: caseDrift.root,
    graphPath: caseDrift.graphPath,
    releaseManifest: caseDrift.releaseManifest,
    originPolicy: ORIGIN_POLICY,
  }), /PRODUCTION_STATIC_PATH_CASE_MISMATCH/);
  await rm(caseDrift.root, { recursive: true, force: true });

  const linked = await graphFixture();
  const original = join(linked.root, 'flock-voice-engine/client/demo.html');
  const target = join(linked.root, 'flock-voice-engine/client/demo-target.html');
  await writeFile(target, await readFile(original));
  await rm(original);
  try {
    await symlink(target, original, 'file');
    await assert.rejects(loadStaticUi({
      repoRoot: linked.root,
      graphPath: linked.graphPath,
      releaseManifest: linked.releaseManifest,
      originPolicy: ORIGIN_POLICY,
    }), /PRODUCTION_STATIC_/);
  } finally {
    await chmod(target, 0o600);
    await rm(linked.root, { recursive: true, force: true });
  }

  const directory = await graphFixture();
  const directoryPath = join(directory.root, 'flock-voice-engine/client/demo.html');
  await rm(directoryPath);
  await mkdir(directoryPath);
  await assert.rejects(loadStaticUi({
    repoRoot: directory.root,
    graphPath: directory.graphPath,
    releaseManifest: directory.releaseManifest,
    originPolicy: ORIGIN_POLICY,
  }), /PRODUCTION_STATIC_PATH_INVALID/);
  await rm(directory.root, { recursive: true, force: true });
});

test('static handler uses exact raw paths, explicitly ignores query and rejects normalization tricks', async (context) => {
  const fixture = await graphFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const staticUi = await loadStaticUi({
    repoRoot: fixture.root,
    graphPath: fixture.graphPath,
    releaseManifest: fixture.releaseManifest,
    originPolicy: ORIGIN_POLICY,
  });
  const withQuery = responseCapture();
  assert.equal(staticUi.handleHttp(documentRequest('/index.html?v=1'), withQuery), true);
  assert.equal(withQuery.statusCode, 200);

  for (const url of [
    '/%69ndex.html',
    '/%zz',
    '/src/../index.html',
    '/src/%2e%2e/index.html',
    '/src\\server-main.js',
    '//index.html',
    '/src//server-main.js',
    'http://localhost/index.html',
    '/index.html#fragment',
    '/Index.html',
    '/src/',
    '/not-in-graph.js',
  ]) {
    const response = responseCapture();
    const handled = staticUi.handleHttp(staticRequest('GET', url), response);
    if (url === '/Index.html' || url === '/src/' || url === '/not-in-graph.js') {
      assert.equal(handled, false, url);
    } else {
      assert.equal(handled, true, url);
      assert.equal(response.statusCode, 404, url);
      assert.equal(response.body.length, 0, url);
    }
  }
  const head = responseCapture();
  assert.equal(staticUi.handleHttp(staticRequest('HEAD', '/demo.html'), head), true);
  assert.equal(head.statusCode, 200);
  assert.equal(head.body.length, 0);
  const post = responseCapture();
  assert.equal(staticUi.handleHttp(staticRequest('POST', '/demo.html'), post), true);
  assert.equal(post.statusCode, 404);
});

test('known static routes enforce exact policy before returning preloaded bytes', async (context) => {
  const fixture = await graphFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const staticUi = await loadStaticUi({
    repoRoot: fixture.root,
    graphPath: fixture.graphPath,
    releaseManifest: fixture.releaseManifest,
    originPolicy: ORIGIN_POLICY,
  });
  for (const [request, expectedStatus] of [
    [staticRequest('GET', '/src/server-main.js', { host: 'evil.example:8090' }), 421],
    [staticRequest('GET', '/src/server-main.js', {
      host: 'evil.example:8090',
      extra: ['Forwarded', 'host=evil.example'],
    }), 403],
    [{
      ...staticRequest('GET', '/src/server-main.js'),
      rawHeaders: ['Host', 'evil.example:8090', 'host', CANONICAL_AUTHORITY],
    }, 400],
    [staticRequest('GET', '/index.html'), 403],
  ]) {
    const response = responseCapture();
    assert.equal(staticUi.handleHttp(request, response), true);
    assert.equal(response.statusCode, expectedStatus);
    assert.equal(response.body.includes(Buffer.from('server-main')), false);
    assert.equal(response.body.includes(Buffer.from('<script')), false);
  }

  const htmlHead = responseCapture();
  assert.equal(staticUi.handleHttp(
    staticRequest('HEAD', '/index.html'),
    htmlHead,
  ), true);
  assert.equal(htmlHead.statusCode, 200);
  assert.equal(htmlHead.body.length, 0);

  const module = responseCapture();
  assert.equal(staticUi.handleHttp(
    staticRequest('GET', '/src/server-main.js'),
    module,
  ), true);
  assert.equal(module.statusCode, 200);
  assert.equal(module.body.toString('utf8'), 'export const ready = true;\n');
});

test('raw TCP static requests reject duplicate, forwarded and wrong Host before bytes', async (context) => {
  const fixture = await graphFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const staticUi = await loadStaticUi({
    repoRoot: fixture.root,
    graphPath: fixture.graphPath,
    releaseManifest: fixture.releaseManifest,
    originPolicy: ORIGIN_POLICY,
  });
  const server = createCandidateServer({ releaseInfo: {}, staticUi });
  context.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  for (const [expected, headers] of [
    [400, [`Host: ${CANONICAL_AUTHORITY}`, `hOsT: ${CANONICAL_AUTHORITY}`]],
    [403, ['Host: evil.example:8090', 'Forwarded: host=evil.example']],
    [421, ['Host: evil.example:8090']],
  ]) {
    const raw = await rawHttp(port, [
      'GET /src/server-main.js HTTP/1.1',
      ...headers,
      'Connection: close',
    ]);
    assert.match(raw, new RegExp(`^HTTP/1\\.1 ${expected} `));
    assert.equal(raw.includes('export const ready'), false);
  }
});

test('candidate server gives raw static guard exclusive precedence over URL, legacy and API handlers', () => {
  const calls = [];
  const server = createCandidateServer({
    releaseInfo: {},
    staticUi: {
      handleHttp(request, response) {
        calls.push(['static', request.url]);
        response.writeHead(404, {});
        response.end();
        return true;
      },
    },
    legacyRoutes: { handleHttp() { calls.push(['legacy']); return true; } },
    apiHandler() { calls.push(['api']); return true; },
  });
  const response = responseCapture();
  server.emit('request', { method: 'GET', url: '/%zz', headers: {} }, response);
  assert.deepEqual(calls, [['static', '/%zz']]);
  assert.equal(response.statusCode, 404);
  server.close();
});

test('production entry validates and preloads the static graph before audio, agents, UDS or listen', async () => {
  const indexPath = fileURLToPath(new URL('../../src/index.js', import.meta.url));
  const source = await readFile(indexPath, 'utf8');
  const policyCreation = source.indexOf('const originPolicy = createOriginPolicy');
  const releaseRead = source.indexOf('await readTrustedReleaseManifest');
  const staticLoad = source.indexOf('await loadStaticUi');
  const frameClock = source.indexOf('const frameClock = createFrameClock');
  const agentComposition = source.indexOf('const agents = createAgentComposition');
  const agentInitialize = source.indexOf('await agents.initialize()');
  const appStart = source.indexOf('await app.start()');
  assert.equal([policyCreation, releaseRead, staticLoad, frameClock, agentComposition,
    agentInitialize, appStart]
    .every((offset) => offset >= 0), true);
  assert.equal(policyCreation < staticLoad, true);
  assert.equal(releaseRead < staticLoad, true);
  assert.equal(staticLoad < frameClock, true);
  assert.equal(staticLoad < agentComposition, true);
  assert.equal(staticLoad < agentInitialize, true);
  assert.equal(staticLoad < appStart, true);
  assert.match(source, /repoRoot:\s*'\/app'/);
  assert.match(source, /graphPath:\s*'\/release\/production-graph\.json'/);
  assert.match(source, /loadStaticUi\(\{[\s\S]*?\boriginPolicy,[\s\S]*?\}\)/);
  assert.match(source, /createAudioWsGateway\(\{[\s\S]*?\boriginPolicy,[\s\S]*?\}\)/);
  assert.match(source, /createLegacyRoutes\(\{[\s\S]*?\boriginPolicy,[\s\S]*?\}\)/);
  assert.match(source, /createRuntimeApp\(\{[\s\S]*?\boriginPolicy,[\s\S]*?\bstaticUi,/);
  assert.equal(source.includes('allowedOrigin'), false);
});
