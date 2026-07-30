import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const CONTROL_URL = new URL(
  '../../src/acceptance/phase5-fault-control-server.js',
  import.meta.url,
);
const INDEX_URL = new URL('../../src/index.js', import.meta.url);
const AUDIO_PROTOCOL_URL = new URL(
  '../../src/audio/worker-protocol.js',
  import.meta.url,
);

async function loadControl() {
  return import(CONTROL_URL.href);
}

test('fault control is a candidate-private dedicated UDS service', async () => {
  const module = await loadControl();
  assert.equal(typeof module.createPhase5FaultControlServer, 'function');
  assert.deepEqual(module.PHASE5_FAULT_CONTROL_SOCKET_PATHS, {
    runtime: '/run/flock-phase5-fault-control/runtime-control.sock',
    audio: '/run/flock-phase5-fault-control/audio-control.sock',
  });
});

test('fault-control request vocabulary has no caller-selected actuator fields',
    async () => {
      const { encodePhase5FaultControlRequest } = await loadControl();
      const forbidden = [
        'operation', 'target', 'receipt', 'script', 'shell', 'argv', 'pid',
        'container', 'socketPath', 'url', 'fixture', 'state', 'timestamp',
      ];
      for (const field of forbidden) {
        assert.throws(
          () => encodePhase5FaultControlRequest({
            schemaVersion: 1,
            kind: 'phase5-fault-control-advance',
            sequence: 1,
            [field]: 'attacker-controlled',
          }),
          /PHASE5_FAULT_CONTROL_REQUEST_INVALID/u,
          field,
        );
      }
    });

test('second connection, replay, skip, concurrency and calls outside the window reject',
    async () => {
      const source = await readFile(CONTROL_URL, 'utf8');
      for (const code of [
        'PHASE5_FAULT_CONTROL_SECOND_CONNECTION',
        'PHASE5_FAULT_CONTROL_SEQUENCE_INVALID',
        'PHASE5_FAULT_CONTROL_CONCURRENT_REQUEST',
        'PHASE5_FAULT_CONTROL_WINDOW_INACTIVE',
      ]) assert.match(source, new RegExp(code, 'u'));
    });

test('client lifecycle action signs durably before its fixed instruction',
    async () => {
      const source = await readFile(new URL(
        '../../src/acceptance/phase5-fault-instruction-channel.js',
        import.meta.url,
      ), 'utf8');
      assert.match(source, /actionEventSha256/u);
      assert.match(source, /acceptCompletion/u);
      assert.match(source, /pending === null/u);
    });

test('production construction cannot create or enable fault control', async () => {
  const source = await readFile(INDEX_URL, 'utf8');
  assert.doesNotMatch(source, /process\.env\.[A-Z0-9_]*FAULT/u);
  assert.match(source, /createPhase5CandidateCaptureOwner/u);
  assert.match(source, /onFaultSessionAuthority/u);
});

test('public worker protocol cannot carry private crash or epoch commands',
    async () => {
      const source = await readFile(AUDIO_PROTOCOL_URL, 'utf8');
      assert.doesNotMatch(source, /crash-child|rotate-epoch/u);
      const launcher = await readFile(new URL(
        '../../../server/audio_worker/launcher.py', import.meta.url,
      ), 'utf8');
      assert.match(launcher, /phase5-audio-control-enable/u);
      assert.match(launcher, /if not FAULT_CONTROL_ROOT\.exists\(\):\s*return None/u);
    });
