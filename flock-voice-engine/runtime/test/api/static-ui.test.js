import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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

test('trusted static loader verifies both graph digests and preloads exact route bytes', async (context) => {
  const fixture = await graphFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const staticUi = await loadStaticUi({
    repoRoot: fixture.root,
    graphPath: fixture.graphPath,
    releaseManifest: fixture.releaseManifest,
  });
  await writeFile(join(fixture.root, 'mvp/index.html'), 'tampered after preload');
  for (const url of ['/', '/index.html', '/demo.html', '/src/server-main.js']) {
    const response = responseCapture();
    assert.equal(staticUi.handleHttp({ method: 'GET', url }, response), true);
    assert.equal(response.statusCode, 200);
    assert.equal(Number(response.headers['content-length']), response.body.length);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['content-type'],
      url.endsWith('.js') ? 'application/javascript; charset=utf-8'
        : 'text/html; charset=utf-8');
  }
  const rootResponse = responseCapture();
  staticUi.handleHttp({ method: 'GET', url: '/' }, rootResponse);
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
  assert.equal(graph.files.length, 164);
  assert.equal(graph.staticRoutes.length, 68);
  const graphBytes = Buffer.from(canonicalJson(graph));
  const graphPath = join(output, 'production-graph.json');
  await writeFile(graphPath, graphBytes);
  const staticUi = await loadStaticUi({
    repoRoot,
    graphPath,
    releaseManifest: { productionGraphSha256: sha(graphBytes) },
  });
  assert.equal(staticUi.graphSha256, graph.sha256);
});

test('trusted static loader rejects case drift, symlinks, directories and missing outer identity', async () => {
  const missing = await graphFixture();
  await assert.rejects(loadStaticUi({
    repoRoot: missing.root,
    graphPath: missing.graphPath,
    releaseManifest: {},
  }), /PRODUCTION_STATIC_GRAPH_IDENTITY_REQUIRED/);
  await rm(missing.root, { recursive: true, force: true });

  const caseDrift = await graphFixture();
  await rename(join(caseDrift.root, 'mvp'), join(caseDrift.root, 'mvp-renaming'));
  await rename(join(caseDrift.root, 'mvp-renaming'), join(caseDrift.root, 'MVP'));
  await assert.rejects(loadStaticUi({
    repoRoot: caseDrift.root,
    graphPath: caseDrift.graphPath,
    releaseManifest: caseDrift.releaseManifest,
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
  });
  const withQuery = responseCapture();
  assert.equal(staticUi.handleHttp({ method: 'GET', url: '/index.html?v=1' }, withQuery), true);
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
    const handled = staticUi.handleHttp({ method: 'GET', url }, response);
    if (url === '/Index.html' || url === '/src/' || url === '/not-in-graph.js') {
      assert.equal(handled, false, url);
    } else {
      assert.equal(handled, true, url);
      assert.equal(response.statusCode, 404, url);
    }
  }
  const head = responseCapture();
  assert.equal(staticUi.handleHttp({ method: 'HEAD', url: '/demo.html' }, head), true);
  assert.equal(head.statusCode, 200);
  assert.equal(head.body.length, 0);
  const post = responseCapture();
  assert.equal(staticUi.handleHttp({ method: 'POST', url: '/demo.html' }, post), true);
  assert.equal(post.statusCode, 404);
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
  const releaseRead = source.indexOf('await readTrustedReleaseManifest');
  const staticLoad = source.indexOf('await loadStaticUi');
  const frameClock = source.indexOf('const frameClock = createFrameClock');
  const agentComposition = source.indexOf('const agents = createAgentComposition');
  const agentInitialize = source.indexOf('await agents.initialize()');
  const appStart = source.indexOf('await app.start()');
  assert.equal([releaseRead, staticLoad, frameClock, agentComposition, agentInitialize, appStart]
    .every((offset) => offset >= 0), true);
  assert.equal(releaseRead < staticLoad, true);
  assert.equal(staticLoad < frameClock, true);
  assert.equal(staticLoad < agentComposition, true);
  assert.equal(staticLoad < agentInitialize, true);
  assert.equal(staticLoad < appStart, true);
  assert.match(source, /repoRoot:\s*'\/app'/);
  assert.match(source, /graphPath:\s*'\/release\/production-graph\.json'/);
  assert.match(source, /createRuntimeApp\(\{[\s\S]*?\bstaticUi,/);
});
