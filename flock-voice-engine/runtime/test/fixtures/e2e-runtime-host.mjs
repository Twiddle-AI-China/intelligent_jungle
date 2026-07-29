import { createHash } from 'node:crypto';
import { createServer as createTcpServer, connect as connectTcp } from 'node:net';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import {
  parseCanonicalRawRequestTarget,
  writeOriginPolicyHttpFailure,
} from '../../src/api/origin-policy.js';
import { loadStaticUi } from '../../src/api/static-ui.js';
import {
  canonicalJson,
  mimeForStaticPath,
} from '../../src/security/static-manifest-contract.js';
import { buildFixedProductionGraph } from '../../tools/production-graph-config.mjs';

function sendNotFound(response) {
  response.writeHead(404, {
    'content-length': 0,
    'x-content-type-options': 'nosniff',
  });
  response.end();
}

async function fixtureFiles(repoRoot, directory) {
  const files = [];
  const pending = [resolve(repoRoot, directory)];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

function repoPath(repoRoot, absolutePath) {
  return relative(repoRoot, absolutePath).split(sep).join('/');
}

export async function createFixtureStaticUi({
  repoRoot,
  entryPath,
  publicDirectories,
  originPolicy,
}) {
  if (!Object.isFrozen(originPolicy)
      || typeof originPolicy.authorize !== 'function'
      || !Array.isArray(publicDirectories)) {
    throw new Error('E2E_STATIC_UI_DEPENDENCIES_REQUIRED');
  }
  const routes = new Map();
  const add = async (url, absolutePath) => {
    const path = repoPath(repoRoot, absolutePath);
    let mime;
    try {
      mime = mimeForStaticPath(path);
    } catch {
      return;
    }
    routes.set(url, Object.freeze({
      bytes: await readFile(absolutePath),
      document: mime === 'text/html; charset=utf-8',
      mime,
    }));
  };
  const absoluteEntry = resolve(repoRoot, entryPath);
  await add('/', absoluteEntry);
  await add('/index.html', absoluteEntry);
  for (const directory of publicDirectories) {
    for (const absolutePath of await fixtureFiles(repoRoot, directory)) {
      await add(`/${repoPath(repoRoot, absolutePath)}`, absolutePath);
    }
  }
  return Object.freeze({
    originPolicy,
    handleHttp(request, response) {
      const parsed = parseCanonicalRawRequestTarget(request.url);
      if (parsed === null) {
        sendNotFound(response);
        return true;
      }
      const route = routes.get(parsed.pathname);
      if (!route) return false;
      const decision = originPolicy.authorize(route.document ? 'document' : 'static', request);
      if (decision.allowed !== true) {
        writeOriginPolicyHttpFailure(response, decision, { head: request.method === 'HEAD' });
        return true;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        sendNotFound(response);
        return true;
      }
      response.writeHead(200, {
        'content-length': route.bytes.length,
        'content-type': route.mime,
        'x-content-type-options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? Buffer.alloc(0) : route.bytes);
      return true;
    },
  });
}

export async function loadFixtureProductionStaticUi({ repoRoot, originPolicy }) {
  const graph = buildFixedProductionGraph(repoRoot);
  const graphBytes = Buffer.from(canonicalJson(graph));
  const directory = await mkdtemp(join(tmpdir(), 'flock-e2e-production-graph-'));
  const graphPath = join(directory, 'production-graph.json');
  await writeFile(graphPath, graphBytes, { flag: 'wx' });
  try {
    const staticUi = await loadStaticUi({
      repoRoot,
      graphPath,
      releaseManifest: Object.freeze({
        productionGraphSha256: createHash('sha256').update(graphBytes).digest('hex'),
      }),
      originPolicy,
    });
    return Object.freeze({
      staticUi,
      async close() {
        await rm(directory, { recursive: true, force: true });
      },
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function listenLoopbackPortMap({
  publicPort = 18090,
  internalPort = 8090,
} = {}) {
  const sockets = new Set();
  const server = createTcpServer((client) => {
    const upstream = connectTcp({
      host: '127.0.0.1',
      port: internalPort,
      localAddress: '127.0.0.2',
    });
    sockets.add(client);
    sockets.add(upstream);
    const discard = (socket) => {
      sockets.delete(socket);
      socket.destroy();
    };
    client.on('error', () => discard(upstream));
    upstream.on('error', () => discard(client));
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(publicPort, '127.0.0.1', () => {
      server.off('error', reject);
      done();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string'
      || !Number.isSafeInteger(address.port) || address.port < 1) {
    await new Promise((done) => server.close(done));
    throw new Error('E2E_PORT_MAP_ADDRESS_INVALID');
  }
  return Object.freeze({
    publicPort: address.port,
    close: () => new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }),
  });
}
