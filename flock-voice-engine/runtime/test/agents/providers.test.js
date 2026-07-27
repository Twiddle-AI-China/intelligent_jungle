import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeepSeekMasterProvider } from '../../src/agents/deepseek-master-provider.js';
import { createSpeciesProvider } from '../../src/agents/species-provider.js';

const flockInput = {
  day: 1,
  flocks: [{
    species: 'melody', homeBranches: [0, 1],
    menu: { dwellBeats: [0.5, 2], activeBars: [0, 4], holdLoops: [2, 8], maxMutations: 2 },
  }],
};
const speciesValue = {
  flocks: [{
    reason: '林群稳定栖息', dwellBeats: 1, activeBars: 2, holdLoops: 4,
    mutations: [{ from: 0, to: 1 }], cellMutations: [],
  }],
  master: { ops: [] },
};
const masterInput = {
  menu: {
    seasons: ['spring', 'summer'],
    colorsBySeason: { spring: ['clear', 'mist'], summer: ['humid'] },
    seasonLengthRange: [8, 16], tensionRange: [0.2, 0.6],
    progressionsBySeason: { summer: ['bloom'] },
  },
  state: { season: 'spring', seasonDay: 3, seasonLength: 8, currentColorId: 'clear' },
  observations: {},
};
const masterValue = {
  reason: '林群保持清朗色彩', colorId: 'mist', tension: 0.4,
  duskColorShift: false, tempoIntent: 'hold',
  nextSeason: null, seasonLength: null, progressionId: null,
};

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function completion(content) {
  return { choices: [{ message: { content } }] };
}

test('provider separation fixes endpoint, model, and server-only authorization', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options, body: JSON.parse(options.body) });
    return calls.length === 1
      ? response(200, completion(JSON.stringify(speciesValue)))
      : response(200, completion(JSON.stringify(masterValue)));
  };
  const signal = new AbortController().signal;
  const species = createSpeciesProvider({ fetchImpl });
  const master = createDeepSeekMasterProvider({ fetchImpl, apiKey: 'server-only' });
  assert.equal((await species.request(flockInput, { signal })).ok, true);
  assert.equal((await master.request(masterInput, { signal })).ok, true);
  assert.equal(calls[0].url, 'http://127.0.0.1:8081/v1/chat/completions');
  assert.equal(calls[0].body.model, 'bird_agent');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[1].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[1].body.model, 'deepseek-v4-flash');
  assert.equal(calls[1].headers.Authorization, 'Bearer server-only');
});

test('adapters return strict typed HTTP, network, and invalid-output results', async () => {
  for (const [status, retryable] of [[400, false], [429, true], [500, true]]) {
    const provider = createSpeciesProvider({ fetchImpl: async () => response(status, { secret: 'not exposed' }) });
    assert.deepEqual(await provider.request(flockInput, {}), {
      ok: false, value: null, status: 'http_error', code: `HTTP_${status}`,
      retryable, httpStatus: status,
    });
  }

  const network = createSpeciesProvider({ fetchImpl: async () => {
    const error = new Error('socket included secret response');
    error.code = 'ECONNRESET';
    throw error;
  } });
  assert.deepEqual(await network.request(flockInput, {}), {
    ok: false, value: null, status: 'network_error', code: 'ECONNRESET',
    retryable: true, httpStatus: null,
  });

  const invalid = createSpeciesProvider({
    fetchImpl: async () => response(200, completion(JSON.stringify({ ...speciesValue, echo: true }))),
  });
  assert.deepEqual(await invalid.request(flockInput, {}), {
    ok: false, value: null, status: 'invalid_output', code: 'INVALID_OUTPUT',
    retryable: false, httpStatus: 200,
  });
});

test('enabled DeepSeek must pass a minimal controlled json_object capability probe', async () => {
  let call;
  const master = createDeepSeekMasterProvider({
    apiKey: 'server-only',
    fetchImpl: async (url, options) => {
      call = { url, headers: options.headers, body: JSON.parse(options.body) };
      return response(200, completion('{"probe":"flock-master-json-v1"}'));
    },
  });
  const probe = await master.probeCapabilities({ signal: new AbortController().signal });
  assert.equal(probe.ok, true);
  assert.deepEqual(probe.value, { probe: 'flock-master-json-v1' });
  assert.equal(call.body.response_format.type, 'json_object');
  assert.match(call.body.messages[0].content, /"additionalProperties":false/);
  assert.equal(call.headers.Authorization, 'Bearer server-only');
});

test('DeepSeek probe rejects malformed, extra-field, and wrong-sentinel output', async () => {
  for (const content of [
    '{',
    '{"probe":"flock-master-json-v1","extra":true}',
    '{"probe":"wrong"}',
  ]) {
    const master = createDeepSeekMasterProvider({
      apiKey: 'k',
      fetchImpl: async () => response(200, completion(content)),
    });
    const result = await master.probeCapabilities({});
    assert.equal(result.ok, false);
    assert.equal(result.status, 'invalid_output');
    assert.equal(result.code, 'INVALID_OUTPUT');
  }
});

test('DeepSeek request locally rejects menu escapes and never returns raw content', async () => {
  const master = createDeepSeekMasterProvider({
    apiKey: 'k',
    fetchImpl: async () => response(200, completion(JSON.stringify({
      ...masterValue, colorId: 'invented', secret: 'raw-provider-body',
    }))),
  });
  assert.deepEqual(await master.request(masterInput, {}), {
    ok: false, value: null, status: 'invalid_output', code: 'INVALID_OUTPUT',
    retryable: false, httpStatus: 200,
  });
});
