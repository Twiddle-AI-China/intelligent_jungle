import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { signedFixture } from './phase5-fault-validation-fixture.js';
import {
  createPhase5LatencyRecorder,
} from '../../tools/lib/phase5-latency-recorder.mjs';

function fixture() {
  const evidence = signedFixture().evidence;
  return {
    binding: Object.fromEntries([
      'runId', 'challenge', 'release', 'geometry', 'profile',
    ].map((name) => [name, structuredClone(evidence[name])])),
    window: structuredClone(evidence.window),
  };
}

test('latency recorder emits validator-owned v2 dual-clock documents', () => {
  const { binding, window } = fixture();
  const recorder = createPhase5LatencyRecorder({ binding, window });
  for (let client = 4; client >= 1; client -= 1) {
    const relative = client * 10;
    recorder.runtimeOpened({
      client, connectionGeneration: 1,
      openedAtMonotonicMs: window.startedAtMonotonicMs + relative,
      openedAtUnixMs: window.startedAtUnixMs + relative,
    });
  }
  for (let client = 1; client <= 4; client += 1) {
    const relative = client * 10 + 100;
    recorder.runtimeReady({
      client, connectionGeneration: 1,
      readyAtMonotonicMs: window.startedAtMonotonicMs + relative,
      readyAtUnixMs: window.startedAtUnixMs + relative,
      readyFrameSha256: String(client).repeat(64),
    });
  }
  const probes = [0, 0, 0, 0];
  for (let index = 0; index < 900; index += 1) {
    const client = index % 4 + 1;
    probes[client - 1] += 1;
    const relative = index * 2_000;
    recorder.uiProbeSent({
      client, connectionGeneration: 1, probeSeq: probes[client - 1],
      sentAtMonotonicMs: window.startedAtMonotonicMs + relative,
      sentAtUnixMs: window.startedAtUnixMs + relative,
    });
    recorder.uiSnapshotObserved({
      client, connectionGeneration: 1, probeSeq: probes[client - 1],
      observedAtMonotonicMs: window.startedAtMonotonicMs + relative + 100,
      observedAtUnixMs: window.startedAtUnixMs + relative + 100,
      snapshotFrameSha256: (index + 1).toString(16).padStart(64, '0'),
    });
  }
  const result = recorder.finalize();
  assert.equal(JSON.parse(result.runtimeReadyBytes).samples.length, 4);
  assert.equal(JSON.parse(result.uiStateLagBytes).samples.length, 900);

  const root = mkdtempSync(join(tmpdir(), 'phase5-latency-'));
  try {
    const runtimePath = join(root, 'runtime.json');
    const uiPath = join(root, 'ui.json');
    writeFileSync(runtimePath, result.runtimeReadyBytes);
    writeFileSync(uiPath, result.uiStateLagBytes);
    const validator = resolve('../tools/validate_phase5_acceptance.py');
    const script = `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("validator",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
for path,fn in ((sys.argv[2],module.validate_phase5_runtime_ready_samples_bytes),(sys.argv[3],module.validate_phase5_ui_state_lag_samples_bytes)):
 raw=open(path,"rb").read(); value=json.loads(raw)
 binding={name:value[name] for name in ("runId","challenge","release","geometry","profile")}
 fn(raw,binding)
`;
    const checked = spawnSync('python3', [
      '-c', script, validator, runtimePath, uiPath,
    ], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
