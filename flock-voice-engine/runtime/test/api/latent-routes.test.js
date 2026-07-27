import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { createLatentRoutes } from '../../src/api/latent-routes.js';

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
    allowedOrigin: 'http://127.0.0.1:4193',
  });
  const server = createServer(handler);
  context.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const good = await fetch(`${origin}/api/v1/latent-maps/melody`, {
    headers: { origin: 'http://127.0.0.1:4193' },
  });
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), dto);
  for (const path of ['texture', '..%2Flead', 'toString', 'melody/extra']) {
    const response = await fetch(`${origin}/api/v1/latent-maps/${path}`, {
      headers: { origin: 'http://127.0.0.1:4193' },
    });
    assert.equal(response.status, 404, path);
  }
  const forbidden = await fetch(`${origin}/api/v1/latent-maps/melody`, {
    headers: { origin: 'https://attacker.test' },
  });
  assert.equal(forbidden.status, 403);
  const json = JSON.stringify(await (await fetch(`${origin}/api/v1/latent-maps/melody`, {
    headers: { origin: 'http://127.0.0.1:4193' },
  })).json());
  for (const privateField of ['basis', 'checkpoint', 'assetRoot', '"z"', 'row']) {
    assert.equal(json.includes(privateField), false, privateField);
  }
});
