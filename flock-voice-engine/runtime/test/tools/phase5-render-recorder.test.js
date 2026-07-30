import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { signedFixture } from './phase5-fault-validation-fixture.js';
import {
  createPhase5RenderRecorder,
} from '../../tools/lib/phase5-render-recorder.mjs';

test('render recorder emits the full 250ms raw cadence accepted by Python', () => {
  const evidence = signedFixture().evidence;
  const binding = Object.fromEntries([
    'runId', 'challenge', 'release', 'geometry', 'profile',
  ].map((name) => [name, structuredClone(evidence[name])]));
  const window = structuredClone(evidence.window);
  const recorder = createPhase5RenderRecorder({ binding, window });
  const blockDurationMs = binding.geometry.blockFrames
    / binding.geometry.sampleRate * 1_000;
  for (let relative = 0; relative <= 1_800_000; relative += 250) {
    recorder.record({
      atMonotonicMs: window.startedAtMonotonicMs + relative,
      atUnixMs: window.startedAtUnixMs + relative,
      renderP95Ms: 10,
      renderP99Ms: 20,
      blockDurationMs,
      recentUnderruns: 0,
    });
  }
  const bytes = recorder.finalize();
  assert.equal(JSON.parse(bytes).samples.length, 7_201);
  const root = mkdtempSync(join(tmpdir(), 'phase5-render-'));
  try {
    const path = join(root, 'render.json');
    writeFileSync(path, bytes);
    const validator = resolve('../tools/validate_phase5_acceptance.py');
    const script = `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("validator",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
raw=open(sys.argv[2],"rb").read(); value=json.loads(raw)
binding={name:value[name] for name in ("runId","challenge","release","geometry","profile")}
module.validate_phase5_render_samples_bytes(raw,binding)
`;
    const checked = spawnSync('python3', [
      '-c', script, validator, path,
    ], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
