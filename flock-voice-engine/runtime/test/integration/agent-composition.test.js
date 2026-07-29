import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { createAgentComposition } from '../../src/agents/agent-composition.js';
import { DOMAIN_CONFIG } from '../../src/domain/config.js';
import { createSimulationRuntime } from '../../src/simulation-runtime.js';

const baseConfig = Object.freeze({
  speciesEnabled: false,
  masterEnabled: false,
  masterBaseUrl: 'https://api.deepseek.com/v1',
  masterModel: 'deepseek-v4-flash',
  masterApiKey: null,
});

async function within(promise, milliseconds = 100) {
  let handle;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        handle = setTimeout(
          () => resolve(Symbol.for('timeout')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(handle);
  }
}

function review(overrides = {}) {
  return {
    requestId: 'r1', scheduleSeq: 1, worldId: 'default',
    worldGeneration: 'generation-a', scheduledWorldRevision: 1,
    reviewedDay: 0, applyBoundary: { kind: 'dawn', day: 1 },
    flockInput: { day: 0, flocks: [] },
    masterInput: { menu: {}, state: {}, observations: {} }, createdAtMs: 0,
    ...overrides,
  };
}

function fakeRunnerFactory(configs) {
  return (config) => {
    configs.push(config);
    return {
      tryStart(job) {
        Promise.resolve(job.invoke({
          signal: new AbortController().signal, attempt: 1, deadlineAtMs: 1_000,
        })).then((result) => job.onSettled({
          requestId: job.requestId,
          channel: config.channel,
          status: result.ok ? 'ok' : result.status === 'invalid_output' ? 'invalid_output' : 'provider_error',
          value: result.ok ? result.value : null,
          attempts: 1, startedAtMs: 0, settledAtMs: 1,
          reason: result.ok ? null : result.code,
        }));
        return { accepted: true, reason: null, requestId: job.requestId };
      },
      getStatus: () => ({ circuitState: 'closed' }),
      close() {},
    };
  };
}

test('composition creates exactly two isolated channel runners', () => {
  const configs = [];
  const agents = createAgentComposition({
    providerConfig: baseConfig,
    fetchImpl: async () => { throw new Error('must not fetch'); },
    runnerFactory: fakeRunnerFactory(configs),
    publishEnvelope() {},
    clock: { now: () => 0 }, setTimer: setTimeout, clearTimer: clearTimeout,
  });
  assert.equal(configs.length, 2);
  assert.deepEqual(configs.map((entry) => entry.channel), ['species', 'master']);
  assert.notEqual(configs[0], configs[1]);
  agents.close();
});

test('disabled master and live Phase 3-4 species perform no provider fetch', async () => {
  let fetchCount = 0;
  const agents = createAgentComposition({
    providerConfig: baseConfig,
    fetchImpl: async () => { fetchCount += 1; throw new Error('offline'); },
    runnerFactory: fakeRunnerFactory([]), publishEnvelope() {},
    clock: { now: () => 0 }, setTimer: setTimeout, clearTimer: clearTimeout,
  });
  await agents.initialize();
  agents.scheduleReview(review());
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(fetchCount, 0);
  assert.equal(agents.getPublicState().species.reason, 'telemetry_unknown');
  assert.equal(agents.getPublicState().master.status, 'disabled');
  await agents.close();
});

test('DeepSeek probe failure keeps policy shadow and sends no business input', async () => {
  const calls = [];
  const agents = createAgentComposition({
    providerConfig: { ...baseConfig, masterEnabled: true, masterApiKey: 'server-only' },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content: '{"probe":"wrong"}' } }] }; } };
    },
    runnerFactory: fakeRunnerFactory([]), publishEnvelope() {},
    clock: { now: () => 0 }, setTimer: setTimeout, clearTimer: clearTimeout,
  });
  await agents.initialize();
  agents.scheduleReview(review());
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(calls.length, 1);
  assert.equal(agents.getPublicState().master.status, 'disabled');
  assert.equal(agents.getPublicState().master.reason, 'deepseek_capability_unavailable');
  await agents.close();
});

test('close aborts and settles an ignored startup capability probe',
    async () => {
      let probeSignal = null;
      const agents = createAgentComposition({
        providerConfig: {
          ...baseConfig,
          masterEnabled: true,
          masterApiKey: 'server-only',
        },
        fetchImpl: async (_url, options) => {
          probeSignal = options.signal;
          return new Promise(() => {});
        },
        runnerFactory: fakeRunnerFactory([]),
        publishEnvelope() {},
        clock: { now: () => 0 },
        setTimer: setTimeout,
        clearTimer: clearTimeout,
      });

      const initializing = agents.initialize();
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.equal(probeSignal?.aborted, false);

      assert.equal(await agents.close(), true);
      assert.equal(probeSignal.aborted, true);
      assert.equal(await within(initializing), false);
    });

test('close aborts the real startup probe transport socket',
    async () => {
      let requests = 0;
      let probeSocket = null;
      let probeSocketClosed = null;
      const server = createServer((request, _response) => {
        requests += 1;
        probeSocket = request.socket;
        probeSocketClosed = once(probeSocket, 'close');
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      const agents = createAgentComposition({
        providerConfig: {
          ...baseConfig,
          masterEnabled: true,
          masterApiKey: 'server-only',
          masterBaseUrl:
            `http://127.0.0.1:${address.port}/v1`,
        },
        runnerFactory: fakeRunnerFactory([]),
        publishEnvelope() {},
        clock: { now: () => 0 },
        setTimer: setTimeout,
        clearTimer: clearTimeout,
      });
      try {
        const initializing = agents.initialize();
        for (let attempt = 0;
          attempt < 20 && requests === 0;
          attempt += 1) {
          await new Promise((resolve) => {
            setImmediate(resolve);
          });
        }
        assert.equal(requests, 1);
        assert.notEqual(probeSocket, null);

        assert.equal(await agents.close(), true);
        assert.equal(await within(initializing), false);
        assert.notEqual(
          await within(probeSocketClosed, 1_000),
          Symbol.for('timeout'),
        );
        assert.equal(probeSocket.destroyed, true);
      } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      }
    });

test('startup capability probe has one owned absolute timeout',
    async () => {
      let probeSignal = null;
      let deadline = null;
      const cleared = [];
      const agents = createAgentComposition({
        providerConfig: {
          ...baseConfig,
          masterEnabled: true,
          masterApiKey: 'server-only',
        },
        fetchImpl: async (_url, options) => {
          probeSignal = options.signal;
          return new Promise(() => {});
        },
        runnerFactory: fakeRunnerFactory([]),
        publishEnvelope() {},
        clock: { now: () => 0 },
        setTimer(callback, milliseconds) {
          deadline = { callback, milliseconds };
          return deadline;
        },
        clearTimer(token) {
          cleared.push(token);
        },
      });

      const initializing = agents.initialize();
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.equal(deadline.milliseconds, 5_000);
      deadline.callback();

      assert.equal(await within(initializing), false);
      assert.equal(probeSignal.aborted, true);
      assert.deepEqual(cleared, [deadline]);
      agents.scheduleReview(review());
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.equal(
        agents.getPublicState().master.reason,
        'deepseek_capability_unavailable',
      );
      await agents.close();
    });

test('successful probe enables only DeepSeek business requests', async () => {
  const calls = [];
  const published = [];
  const agents = createAgentComposition({
    providerConfig: { ...baseConfig, masterEnabled: true, masterApiKey: 'server-only' },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body, headers: options.headers });
      const content = calls.length === 1
        ? '{"probe":"flock-master-json-v1"}'
        : JSON.stringify({
          reason: '林群保持稳定', colorId: 'base', tension: 0.5,
          duskColorShift: false, tempoIntent: 'hold', nextSeason: null,
          seasonLength: null, progressionId: null,
        });
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content } }] }; } };
    },
    runnerFactory: fakeRunnerFactory([]), publishEnvelope: (value) => published.push(value),
    clock: { now: () => 0 }, setTimer: setTimeout, clearTimer: clearTimeout,
  });
  await agents.initialize();
  agents.scheduleReview(review());
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.response_format.type, 'json_object');
  assert.equal(calls[1].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[1].body.model, 'deepseek-v4-flash');
  assert.equal(calls[1].headers.Authorization, 'Bearer server-only');
  assert.equal(published.some((entry) => entry.channel === 'master'), true);
  await agents.close();
});

test('test-only complete telemetry admits localhost species without provider crossover', async () => {
  const calls = [];
  const telemetry = {
    workerReady: true, recovering: false, pcmHeadroomBlocks: 3,
    audioQueueDepth: 1, renderP95Ratio: 0.7, renderP99Ratio: 0.9,
    recentUnderruns: 0, unifiedMemoryFreeBytes: 12 * 1024 ** 3, sampledAtMs: 0,
  };
  const agents = createAgentComposition({
    providerConfig: baseConfig,
    speciesTelemetry: telemetry,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content: '{"flocks":[],"master":{"ops":[]}}' } }] }; } };
    },
    runnerFactory: fakeRunnerFactory([]), publishEnvelope() {},
    clock: { now: () => 0 }, setTimer: setTimeout, clearTimer: clearTimeout,
  });
  await agents.initialize();
  agents.scheduleReview(review());
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8081/v1/chat/completions');
  assert.equal(calls[0].body.model, 'bird_agent');
  await agents.close();
});

test('ignored Abort shutdown is bounded and publishes no post-close envelope', async () => {
  const published = [];
  const agents = createAgentComposition({
    providerConfig: baseConfig,
    speciesTelemetry: {
      workerReady: true, recovering: false, pcmHeadroomBlocks: 3,
      audioQueueDepth: 1, renderP95Ratio: 0.7, renderP99Ratio: 0.9,
      recentUnderruns: 0, unifiedMemoryFreeBytes: 12 * 1024 ** 3, sampledAtMs: 0,
    },
    fetchImpl: async () => new Promise(() => {}),
    publishEnvelope: (value) => published.push(value),
    clock: { now: () => 0 }, closeDrainTimeoutMs: 10,
  });
  await agents.initialize();
  agents.scheduleReview(review());
  const startedAt = Date.now();
  await agents.close();
  assert.ok(Date.now() - startedAt < 500);
  assert.deepEqual(published, []);
});

test('real composition schedules at dawn N and applies accepted master at dawn N+1', async () => {
  const published = [];
  let fetchCount = 0;
  let runtime = null;
  const agents = createAgentComposition({
    providerConfig: { ...baseConfig, masterEnabled: true, masterApiKey: 'server-only' },
    fetchImpl: async (_url, options) => {
      fetchCount += 1;
      const body = JSON.parse(options.body);
      let content = '{"probe":"flock-master-json-v1"}';
      if (fetchCount > 1) {
        const input = JSON.parse(body.messages[1].content);
        const season = input.state.season ?? input.state.currentSeason;
        const colorId = input.state.currentColorId
          ?? input.menu.colorsBySeason?.[season]?.[0];
        content = JSON.stringify({
          reason: '林群稳定跨日', colorId, tension: input.menu.tensionRange[0],
          duskColorShift: false, tempoIntent: 'hold', nextSeason: null,
          seasonLength: null, progressionId: null,
        });
      }
      return {
        ok: true, status: 200,
        async json() { return { choices: [{ message: { content } }] }; },
      };
    },
    publishEnvelope(value) { published.push(value); },
    clock: { now: () => 0 },
  });
  await agents.initialize();
  runtime = createSimulationRuntime({ seed: 0x4c4353, agents, clock: { now: () => 0 } });
  let revision = 0;
  try {
    while (runtime.getSnapshot().day < 2) {
      runtime.setAgentContext({ worldGeneration: 'generation-a', currentWorldRevision: revision });
      runtime.tick(1 / DOMAIN_CONFIG.sim.tickHz);
      revision += 1;
    }
    await new Promise((resolve) => { setImmediate(resolve); });
    await new Promise((resolve) => { setImmediate(resolve); });
    const masterEnvelope = published.find((entry) => entry.channel === 'master');
    assert.ok(masterEnvelope);
    assert.equal(masterEnvelope.applyBoundary.day, 3);
    runtime.setAgentContext({ worldGeneration: 'generation-a', currentWorldRevision: revision });
    assert.equal(runtime.acceptAgentResult(masterEnvelope).commandResult.accepted, true);
    let dawnDraft = null;
    while (runtime.getSnapshot().day < 3) {
      runtime.setAgentContext({ worldGeneration: 'generation-a', currentWorldRevision: revision });
      dawnDraft = runtime.tick(1 / DOMAIN_CONFIG.sim.tickHz);
      revision += 1;
    }
    assert.equal(agents.getPublicState().lastDecision.master.source, 'llm');
    assert.equal(agents.getPublicState().lastDecision.applyBoundary.day, 3);
    const decision = dawnDraft.domainEvents.find((event) => event.name === 'decision');
    assert.equal(decision.payload.master.source, 'llm');
    assert.equal(JSON.stringify(decision).includes('林群稳定跨日'), false);
  } finally {
    runtime.dispose();
    await agents.close();
  }
});
