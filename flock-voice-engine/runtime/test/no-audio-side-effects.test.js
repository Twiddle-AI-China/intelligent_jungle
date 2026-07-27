import assert from 'node:assert/strict';
import test from 'node:test';

test('simulation runtime import/construct/tick 不触碰 browser 与外部音频 IO', async () => {
  const originals = new Map();
  for (const name of ['fetch', 'WebSocket', 'AudioContext']) {
    originals.set(name, globalThis[name]);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value() {
        throw new Error(`forbidden global: ${name}`);
      },
    });
  }
  try {
    const { createSimulationRuntime } = await import('../src/simulation-runtime.js');
    const runtime = createSimulationRuntime({ seed: 0x4c4353 });
    assert.doesNotThrow(() => runtime.tick(1 / 30));
    runtime.dispose();
  } finally {
    for (const [name, value] of originals) {
      if (value === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, { configurable: true, value });
    }
  }
});
