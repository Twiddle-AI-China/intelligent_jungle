import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { signedFixture } from './phase5-fault-validation-fixture.js';
import {
  writePhase5RawTempDirectory,
} from '../../tools/lib/phase5-raw-bundle.mjs';

test('raw bundle writes only ten durable leaves and the owned manifest', async () => {
  const evidence = signedFixture().evidence;
  const root = await mkdtemp(join(tmpdir(), 'phase5-raw-bundle-'));
  const tempDirectory = join(root, '.acceptance-evidence-test');
  await mkdir(tempDirectory, { mode: 0o700 });
  const names = [
    'faultEventsSha256', 'soakRunSha256', 'rawRuntimeReadySamplesSha256',
    'rawUiStateLagSamplesSha256', 'rawRenderSamplesSha256',
    'clientObservationsSha256', 'speciesNormalSamplesSha256',
    'speciesBurstSamplesSha256', 'phase5E2eSha256', 'leaseEvidenceSha256',
  ];
  const evidenceBlobs = Object.fromEntries(names.map(
    (name) => [name, Buffer.from(`{"artifact":"${name}"}`)],
  ));
  const externalBlobs = Object.fromEntries([
    'productionGraphSha256', 'productionMachineAttestationSha256',
    'listeningChecklistSha256', 'equivalenceSha256',
  ].map((name) => [name, Buffer.from(`{"external":"${name}"}`)]));
  try {
    const result = await writePhase5RawTempDirectory({ tempDirectory,
      binding: Object.fromEntries(['runId', 'challenge', 'release', 'geometry', 'profile']
        .map((name) => [name, evidence[name]])), window: evidence.window,
      evidenceBlobs, externalBlobs });
    assert.deepEqual(await readFile(join(tempDirectory,
      'phase5-raw-manifest.json')), result.manifestBytes);
    await assert.rejects(writePhase5RawTempDirectory({ tempDirectory,
      binding: {}, window: {}, evidenceBlobs, externalBlobs }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
