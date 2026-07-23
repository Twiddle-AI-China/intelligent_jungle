import test from 'node:test';
import assert from 'node:assert/strict';

import { createPcmPlayer } from '../src/pcm-player.js';

function expectDisabledError(error) {
  assert.equal(error?.name, 'Error');
  assert.equal(error?.code, 'PCM_DISABLED_PHASE_1_2');
  assert.equal(error?.message, 'PCM_DISABLED_PHASE_1_2');
  return true;
}

test('所有 runtimeOwner/audioOwner tuple 都保持 disabled 且不调用 factories', async () => {
  let audioContextCalls = 0;
  let webSocketCalls = 0;
  const ownerTuples = [
    ['browser', 'legacy'],
    ['browser', 'world'],
    ['server', 'legacy'],
    ['server', 'world'],
  ];

  for (const [runtimeOwner, audioOwner] of ownerTuples) {
    const player = createPcmPlayer({
      runtimeOwner,
      audioOwner,
      audioContextFactory() {
        audioContextCalls += 1;
        throw new Error('must not create AudioContext');
      },
      webSocketFactory() {
        webSocketCalls += 1;
        throw new Error('must not open Audio WS');
      },
    });

    await assert.rejects(player.start(), expectDisabledError);
    assert.equal(player.stop(), undefined);
    assert.equal(player.stop(), undefined);
    assert.equal(player.reset(), undefined);
    assert.equal(player.reset(), undefined);
    assert.deepEqual(player.getStatus(), {
      state: 'disabled',
      bufferedFrames: 0,
    });
    assert.equal(Object.isFrozen(player.getStatus()), true);
  }

  assert.equal(audioContextCalls, 0);
  assert.equal(webSocketCalls, 0);
});

test('重复及并发 start 每次都 reject，不产生任何生命周期副作用', async () => {
  let factoryCalls = 0;
  const player = createPcmPlayer({
    runtimeOwner: 'server',
    audioOwner: 'world',
    audioContextFactory() {
      factoryCalls += 1;
    },
    webSocketFactory() {
      factoryCalls += 1;
    },
  });

  const attempts = await Promise.allSettled([
    player.start(),
    player.start(),
    player.start(),
  ]);
  assert.equal(attempts.length, 3);
  for (const attempt of attempts) {
    assert.equal(attempt.status, 'rejected');
    expectDisabledError(attempt.reason);
  }
  assert.equal(factoryCalls, 0);
  assert.deepEqual(player.getStatus(), {
    state: 'disabled',
    bufferedFrames: 0,
  });
});

test('construction 与所有方法不读取 factory getter 或 WebAudio/WebSocket globals', async () => {
  const dependencies = {
    runtimeOwner: 'server',
    audioOwner: 'world',
    get audioContextFactory() {
      throw new Error('must not inspect audioContextFactory');
    },
    get webSocketFactory() {
      throw new Error('must not inspect webSocketFactory');
    },
  };
  const originalAudioContext = Object.getOwnPropertyDescriptor(
    globalThis,
    'AudioContext',
  );
  const originalWebSocket = Object.getOwnPropertyDescriptor(
    globalThis,
    'WebSocket',
  );
  let globalReads = 0;

  try {
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      get() {
        globalReads += 1;
        throw new Error('must not read global AudioContext');
      },
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      get() {
        globalReads += 1;
        throw new Error('must not read global WebSocket');
      },
    });

    const player = createPcmPlayer(dependencies);
    assert.deepEqual(player.getStatus(), {
      state: 'disabled',
      bufferedFrames: 0,
    });
    player.stop();
    player.reset();
    await assert.rejects(player.start(), expectDisabledError);
    assert.equal(globalReads, 0);
  } finally {
    if (originalAudioContext) {
      Object.defineProperty(
        globalThis,
        'AudioContext',
        originalAudioContext,
      );
    } else {
      delete globalThis.AudioContext;
    }
    if (originalWebSocket) {
      Object.defineProperty(globalThis, 'WebSocket', originalWebSocket);
    } else {
      delete globalThis.WebSocket;
    }
  }
});

test('public facade 与 status 都冻结，外部不能启用或替换生命周期', () => {
  const player = createPcmPlayer();
  const expectedKeys = ['getStatus', 'reset', 'start', 'stop'];

  assert.equal(Object.isFrozen(player), true);
  assert.deepEqual(Object.keys(player).sort(), expectedKeys);
  assert.throws(() => {
    player.start = async () => {};
  }, TypeError);

  const status = player.getStatus();
  assert.equal(Object.isFrozen(status), true);
  assert.throws(() => {
    status.state = 'enabled';
  }, TypeError);
  assert.deepEqual(player.getStatus(), {
    state: 'disabled',
    bufferedFrames: 0,
  });
});
