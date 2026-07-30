import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { signedFixture } from './phase5-fault-validation-fixture.js';
import {
  buildPhase5RawManifest, PHASE5_RAW_ARTIFACTS,
} from '../../tools/lib/phase5-raw-manifest.mjs';

test('raw manifest freezes the Python-owned fourteen-leaf order', () => {
  const evidence = signedFixture().evidence;
  const binding = Object.fromEntries([
    'runId', 'challenge', 'release', 'geometry', 'profile',
  ].map((name) => [name, structuredClone(evidence[name])]));
  const blobs = Object.fromEntries(PHASE5_RAW_ARTIFACTS.map(
    ([artifact], index) => [artifact, Buffer.from(`blob-${index + 1}`)],
  ));
  const bytes = buildPhase5RawManifest({
    binding, window: structuredClone(evidence.window), blobs,
  });
  const value = JSON.parse(bytes);
  assert.deepEqual(value.artifacts.map(({ artifact, path }) => (
    [artifact, path]
  )), PHASE5_RAW_ARTIFACTS.map((item) => [...item]));

  const root = mkdtempSync(join(tmpdir(), 'phase5-manifest-'));
  try {
    const path = join(root, 'manifest.json');
    writeFileSync(path, bytes);
    const validator = resolve('../tools/validate_phase5_acceptance.py');
    const script = `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("validator",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
raw=open(sys.argv[2],"rb").read(); value=json.loads(raw)
binding={name:value[name] for name in ("runId","challenge","release","geometry","profile")}
module.validate_phase5_raw_manifest_bytes(raw,binding)
`;
    const checked = spawnSync('python3', [
      '-c', script, validator, path,
    ], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
