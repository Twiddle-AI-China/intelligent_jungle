import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as requestHttp } from 'node:http';
import test from 'node:test';

import { createLatentRoutes } from '../../src/api/latent-routes.js';
import { createOriginPolicy } from '../../src/api/origin-policy.js';

const CANONICAL_ORIGIN = 'http://127.0.0.1:18090';
const CANONICAL_AUTHORITY = '127.0.0.1:18090';
const ORIGIN_POLICY = createOriginPolicy({ canonicalOrigin: CANONICAL_ORIGIN });

function requestJson(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = requestHttp({
      host: '127.0.0.1',
      port,
      path,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: bytes.length === 0 ? null : JSON.parse(bytes.toString('utf8')),
        });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

test('latent map route serves only the safe DTO and rejects traversal/unavailable voices', async (context) => {
  const dto = Object.freeze({
    voice: 'melody', points: [{ id: 'p', x: 0, y: 0 }], range: { x: [-1, 1], y: [-1, 1] },
    pcaDimensions: 2, pcaRanges: [], cursor: { mode: 'xy', x: 0, y: 0, pca: [] }, neighbors: [],
  });
  const handler = createLatentRoutes({
    getPublicMap: async (voice) => {
      if (voice !== 'melody') throw new Error('LATENT_VOICE_UNAVAILABLE');
      return dto;
    },
    originPolicy: ORIGIN_POLICY,
  });
  const server = createServer(handler);
  context.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const exactHeaders = { Host: CANONICAL_AUTHORITY, Origin: CANONICAL_ORIGIN };
  const good = await requestJson(port, '/api/v1/latent-maps/melody', exactHeaders);
  assert.equal(good.status, 200);
  assert.deepEqual(good.body, dto);
  assert.equal(good.headers['access-control-allow-origin'], undefined);
  assert.equal(good.headers.vary, undefined);
  for (const path of ['texture', '..%2Flead', 'toString', 'melody/extra']) {
    const response = await requestJson(port, `/api/v1/latent-maps/${path}`, exactHeaders);
    assert.equal(response.status, 404, path);
  }
  const forbidden = await requestJson(port, '/api/v1/latent-maps/melody', {
    Host: CANONICAL_AUTHORITY,
    Origin: 'https://attacker.test',
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers['access-control-allow-origin'], undefined);
  assert.equal(forbidden.headers.vary, undefined);
  const json = JSON.stringify((await requestJson(
    port,
    '/api/v1/latent-maps/melody',
    exactHeaders,
  )).body);
  for (const privateField of ['basis', 'checkpoint', 'assetRoot', '"z"', 'row']) {
    assert.equal(json.includes(privateField), false, privateField);
  }
});

test('latent route rejects malformed targets and wrong Host requests before map access', async () => {
  let reads = 0;
  const handler = createLatentRoutes({
    getPublicMap() {
      reads += 1;
      throw new Error('must not run');
    },
    originPolicy: ORIGIN_POLICY,
  });
  function responseCapture() {
    return {
      headersSent: false,
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
        this.headersSent = true;
      },
      end(body) {
        this.body = body;
      },
    };
  }
  for (const [rawHeaders, expected] of [
    [[
      'Host', 'evil.example:8090',
      'host', CANONICAL_AUTHORITY,
      'Forwarded', 'host=evil.example',
    ], 400],
    [[
      'Host', 'evil.example:8090',
      'Forwarded', 'host=evil.example',
    ], 403],
    [['Host', 'evil.example:8090', 'Origin', CANONICAL_ORIGIN], 421],
  ]) {
    const response = responseCapture();
    assert.equal(handler({
      method: 'GET',
      url: '/api/v1/latent-maps/melody',
      rawHeaders,
      headers: { host: CANONICAL_AUTHORITY, origin: CANONICAL_ORIGIN },
    }, response), true);
    assert.equal(response.statusCode, expected);
  }
  for (const url of [
    'http://evil.example/api/v1/latent-maps/melody',
    '//evil.example/api/v1/latent-maps/melody',
    '/api/v1/latent-maps/%6delody',
    '/api/v1/latent-maps/../latent-maps/melody',
    '\\api\\v1\\latent-maps\\melody',
    '/api/v1/latent-maps/melody#fragment',
    '/api/v1/latent-maps/melody\r\n',
  ]) {
    const response = responseCapture();
    assert.equal(handler({
      method: 'GET',
      url,
      rawHeaders: ['Host', CANONICAL_AUTHORITY, 'Origin', CANONICAL_ORIGIN],
      headers: { host: CANONICAL_AUTHORITY, origin: CANONICAL_ORIGIN },
    }, response), true);
    assert.equal(response.statusCode, 404, url);
  }
  let queryPolicyReads = 0;
  const queryHandler = createLatentRoutes({
    getPublicMap() {
      reads += 1;
      throw new Error('must not run');
    },
    originPolicy: Object.freeze({
      authorize() {
        queryPolicyReads += 1;
        return Object.freeze({ allowed: true, branch: 'browser' });
      },
    }),
  });
  for (const url of [
    '/api/v1/latent-maps/melody?',
    '/api/v1/latent-maps/melody?cache=0',
  ]) {
    const response = responseCapture();
    assert.equal(queryHandler({
      method: 'GET',
      url,
      rawHeaders: ['Host', CANONICAL_AUTHORITY, 'Origin', CANONICAL_ORIGIN],
      headers: { host: CANONICAL_AUTHORITY, origin: CANONICAL_ORIGIN },
    }, response), true);
    assert.equal(response.statusCode, 404, url);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 0);
  assert.equal(queryPolicyReads, 0);
});
